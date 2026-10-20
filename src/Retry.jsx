import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ethers } from 'ethers'

const HALLIDAY_API_KEY = import.meta.env.VITE_HALLIDAY_API_KEY
const API_URL = 'https://v2.prod.halliday.xyz'

async function api(path, body) {
  const res = await fetch(API_URL + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body)
  })
  const data = await res.json()
  if (!res.ok || data.errors) throw new Error(JSON.stringify(data.errors || data))
  return data
}

export default function Retry() {
  const [screen, setScreen] = useState('selection')
  const [userAddress, setUserAddress] = useState('')
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedPayment, setSelectedPayment] = useState(null)
  const [balances, setBalances] = useState(null)
  const [assets, setAssets] = useState({})
  const [chains, setChains] = useState({})
  const [retries, setRetries] = useState({})
  const intervalsRef = useRef({})

  function clearIntervals() {
    Object.values(intervalsRef.current).forEach(clearInterval)
    intervalsRef.current = {}
  }

  async function loadMetadata() {
    const [assetsData, chainsData] = await Promise.all([api('/assets'), api('/chains')])
    setAssets(assetsData)
    setChains(chainsData)
  }

  async function checkExistingConnection() {
    if (!window.ethereum) return
    const accounts = await window.ethereum.request({ method: 'eth_accounts' })
    if (accounts.length) {
      setUserAddress(accounts[0])
      await loadPayments(accounts[0])
    }
  }

  useEffect(() => {
    if (!HALLIDAY_API_KEY) alert('VITE_HALLIDAY_API_KEY is missing in .env!')
    loadMetadata().catch((err) => alert(err.message))
    checkExistingConnection()
    return clearIntervals
  }, [])

  async function connectWallet() {
    if (!window.ethereum) return alert('No wallet found. Install MetaMask.')
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
    setUserAddress(accounts[0])
    await loadPayments(accounts[0])
  }

  async function disconnect() {
    await window.ethereum.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
    setUserAddress('')
    setPayments([])
  }

  async function loadPayments(address) {
    setLoading(true)
    try {
      const data = await api(`/payments/history?categories[]=ALL&owner_address=${address}&limit=500`)
      const incomplete = []

      for (const payment of data.payment_statuses?.slice(0, 15) || []) {
        if (payment.status === 'COMPLETE') continue
        const balData = await api('/payments/balances', {
          query: { source: 'OWNER', owner: address, scope: { kind: 'PAYMENT', payment_id: payment.payment_id } }
        })
        const stuck = balData.balance_results?.reduce((sum, b) => sum + +b.value.amount, 0) || 0
        if (stuck > 0) {
          incomplete.push({ ...payment, balances: balData, stuck })
        }
      }
      setPayments(incomplete)
    } catch (err) {
      alert(err.message)
    }
    setLoading(false)
  }

  async function getQuote(payment, balance) {
    return api('/payments/quotes', {
      request: {
        kind: 'FIXED_INPUT',
        fixed_input_amount: { asset: balance.token, amount: balance.value.amount },
        output_asset: payment.quoted?.output_amount?.asset
      },
      price_currency: 'USD',
      parent_payment_id: payment.payment_id
    })
  }

  async function acceptQuote(quoteData) {
    return api('/payments/confirm', {
      payment_id: quoteData.quotes[0].payment_id,
      state_token: quoteData.state_token,
      owner_address: userAddress,
      destination_address: userAddress
    })
  }

  // Handle USER_VERIFY instructions (owner verify >= $300, withdrawal sim >= $1M)
  async function handleVerification(confirmResult) {
    const provider = new ethers.BrowserProvider(window.ethereum)
    const signer = await provider.getSigner()
    const { verification_token, verifications } = confirmResult.next_instruction

    const signatures = await Promise.all(
      verifications.map(async (v) => {
        let signature
        if (v.signature_type === 'EIP712') {
          const typedData = JSON.parse(v.payload)
          const { EIP712Domain, ...types } = typedData.types
          signature = await signer.signTypedData(typedData.domain, types, typedData.message)
        } else {
          signature = await signer.signMessage(v.payload)
        }
        return { reason: v.reason, signature_type: v.signature_type, signature }
      })
    )

    const verifyRes = await fetch(API_URL + '/payments/confirm', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ verification_token, signatures })
    })

    if (verifyRes.status === 409) return api(`/payments?payment_id=${confirmResult.payment_id}`)
    if (verifyRes.status === 400) throw new Error('Quote expired. Please try again.')
    if (verifyRes.status === 401) throw new Error('Signature verification failed. Please try again.')
    if (!verifyRes.ok) throw new Error(await verifyRes.text())

    return verifyRes.json()
  }

  function updateRetry(token, update) {
    setRetries((prev) => ({ ...prev, [token]: { ...prev[token], ...update } }))
  }

  async function handleRetry(balance) {
    const token = balance.token
    updateRetry(token, { status: 'QUOTING' })

    try {
      const quoteData = await getQuote(selectedPayment, balance)
      if (!quoteData.quotes?.length) throw new Error('Retry not possible. Try withdrawal.')

      let accepted = await acceptQuote(quoteData)
      while (accepted.next_instruction?.type === 'USER_VERIFY') {
        accepted = await handleVerification(accepted)
      }
      const newPaymentId = accepted.payment_id
      updateRetry(token, { paymentId: newPaymentId, status: accepted.status })

      // Withdraw the stuck funds into the new payment's deposit address
      const typedData = await api('/payments/withdraw', {
        withdraw_from: balance.withdraw_from,
        token_amounts: [{ token, amount: balance.value.amount }],
        recipient_address: accepted.next_instruction.deposit_info[0].deposit_address
      })
      const { domain, types, message } = JSON.parse(typedData.withdraw_authorization)
      delete types.EIP712Domain

      const provider = new ethers.BrowserProvider(window.ethereum)
      const signer = await provider.getSigner()
      const signature = await signer.signTypedData(domain, types, message)

      await api('/payments/withdraw/confirm', { signature, state_token: typedData.state_token })

      intervalsRef.current[token] = setInterval(async () => {
        const status = await api(`/payments?payment_id=${newPaymentId}`)
        const update = { status: status.status, route: status.fulfilled?.route }
        if (status.status === 'COMPLETE') {
          clearInterval(intervalsRef.current[token])
          const route = status.fulfilled.route
          update.txHash = route[route.length - 1].transaction_hash
          update.chain = status.fulfilled.output_amount.asset.split(':')[0]
        }
        updateRetry(token, update)
      }, 3000)
    } catch (err) {
      alert(err.message)
      setRetries((prev) => {
        const next = { ...prev }
        delete next[token]
        return next
      })
    }
  }

  function getPaymentInfo(payment) {
    const route = payment.quoted?.route?.[0]
    const type = route?.type === 'USER_FUND' ? 'Swap' : 'Onramp'
    const input = type === 'Onramp'
      ? route?.net_effect?.consume?.[0]?.resource?.asset?.toUpperCase()
      : assets[route?.net_effect?.consume?.[0]?.resource?.asset]?.symbol
    const output = assets[payment.quoted?.output_amount?.asset]?.symbol
    const onramp = payment.quoted?.onramp
    const provider = onramp ? onramp[0].toUpperCase() + onramp.slice(1) : 'Halliday'
    return { type, input, output, provider, status: payment.status, time: new Date(payment.created_at).toLocaleString() }
  }

  if (screen === 'signing' && selectedPayment) {
    const info = getPaymentInfo(selectedPayment)
    return (
      <div className="container">
        <div className="back-button" onClick={() => { clearIntervals(); setScreen('selection'); setRetries({}) }}>←</div>
        <h2 className="text-center">Retry Payment</h2>
        <div className="payment-info-card">
          <span className="payment-type">{info.type} ({info.status})</span>
          <span>{info.input} → {info.output} via {info.provider}</span>
          <span>Stuck: {selectedPayment.stuck}</span>
          <span>{info.time}</span>
        </div>
        <p className="info-label">No user gas tokens are spent when executing a retry payment.</p>
        <div>
          {balances?.balance_results?.filter((b) => +b.value.amount > 0).map((balance) => {
            const retry = retries[balance.token]
            const explorer = chains[retry?.chain]?.explorer
            return (
              <div key={balance.token} className="withdrawal-option-card">
                <div className="token-name">{assets[balance.token]?.name || balance.token}</div>
                <div className="token-amount">Amount stuck: {balance.value.amount}</div>
                {retry?.paymentId && <div className="token-amount">Payment ID: {retry.paymentId}</div>}
                {retry && <div className="token-amount">Status: {retry.status}</div>}
                {retry?.route && (
                  <ul>
                    {retry.route.map((step, i) => (
                      <li key={i}>{step.type}: {step.status}</li>
                    ))}
                  </ul>
                )}
                <div className="transaction">
                  {retry?.txHash && <a href={`${explorer}tx/${retry.txHash}`} target="_blank" rel="noreferrer">See Transaction</a>}
                </div>
                <button
                  className={`small-button ${retry && retry.status !== 'COMPLETE' ? 'loading' : ''}`}
                  onClick={() => handleRetry(balance)}
                  disabled={!!retry}
                >
                  Sign & Retry Payment
                </button>
              </div>
            )
          })}
        </div>
        <div className="powered-by">Powered by Halliday</div>
      </div>
    )
  }

  return (
    <div className="container">
      <Link to="/" className="back-button">←</Link>
      <h2 className="text-center">Retry Payment</h2>
      <p className="info-label">Retry an incomplete payment using the payment's owner wallet. Try with an EIP-1193 wallet like MetaMask, Rabby, or Phantom.</p>

      <div className="connect-wallet-container">
        {!userAddress ? (
          <button className="button enabled" onClick={connectWallet}>Connect Wallet</button>
        ) : (
          <p className="info-label">
            Connected wallet:
            <br />
            <span className="address-label">{userAddress}</span>
            <br />
            <button className="disconnect" onClick={disconnect}>Disconnect</button>
          </p>
        )}
      </div>

      <h2>Transaction History</h2>
      <div className="transaction-history-container">
        {loading && <div className="loading-spinner" />}
        <ul>
          {payments.map((payment) => {
            const info = getPaymentInfo(payment)
            return (
              <li key={payment.payment_id}>
                <div className="transaction-info">
                  <div className="transaction-row">
                    <span className="transaction-type">{info.type} ({info.status})</span>
                  </div>
                  <div className="transaction-route">{info.input} → {info.output} via {info.provider}</div>
                  <div className="transaction-stuck">Stuck: {payment.stuck}</div>
                  <div className="transaction-time">{info.time}</div>
                </div>
                <button className="small-button" onClick={() => { setSelectedPayment(payment); setBalances(payment.balances); setScreen('signing') }}>
                  Retry
                </button>
              </li>
            )
          })}
        </ul>
        {!loading && payments.length === 0 && userAddress && <p className="info-label">No incomplete payments found.</p>}
      </div>
      <div className="powered-by">Powered by Halliday</div>
    </div>
  )
}
