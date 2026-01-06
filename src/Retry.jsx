import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ethers } from 'ethers'

const HALLIDAY_API_KEY = import.meta.env.VITE_HALLIDAY_API_KEY

export default function Retry() {
  const [screen, setScreen] = useState('selection')
  const [userAddress, setUserAddress] = useState('')
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedPayment, setSelectedPayment] = useState(null)
  const [balances, setBalances] = useState(null)
  const [assets, setAssets] = useState({})
  const [chains, setChains] = useState({})
  const [retryStatus, setRetryStatus] = useState(null)
  const intervalRef = useRef(null)

  useEffect(() => {
    if (!HALLIDAY_API_KEY) alert('VITE_HALLIDAY_API_KEY is missing in .env!')
    loadMetadata()
    checkExistingConnection()
    return () => clearInterval(intervalRef.current)
  }, [])

  async function loadMetadata() {
    const [assetsRes, chainsRes] = await Promise.all([
      fetch('https://v2.prod.halliday.xyz/assets', { headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY } }),
      fetch('https://v2.prod.halliday.xyz/chains', { headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY } })
    ])
    setAssets(await assetsRes.json())
    setChains(await chainsRes.json())
  }

  async function checkExistingConnection() {
    if (!window.ethereum) return
    const accounts = await window.ethereum.request({ method: 'eth_accounts' })
    if (accounts.length) {
      setUserAddress(accounts[0])
      await loadPayments(accounts[0])
    }
  }

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
    const res = await fetch(`https://v2.prod.halliday.xyz/payments/history?category=ALL&owner_address=${address}`, {
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY }
    })
    const data = await res.json()
    const incomplete = []

    for (const payment of data.payment_statuses?.slice(0, 10) || []) {
      if (payment.status === 'COMPLETE') continue
      const balRes = await fetch('https://v2.prod.halliday.xyz/payments/balances', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_id: payment.payment_id })
      })
      const balData = await balRes.json()
      const stuck = balData.balance_results?.reduce((sum, b) => sum + +b.value.amount, 0) || 0
      if (stuck > 0) {
        incomplete.push({ ...payment, balances: balData, stuck })
      }
    }
    setPayments(incomplete)
    setLoading(false)
  }

  async function getQuote(payment) {
    const route = payment.quoted?.route?.[0]
    const inputAsset = route?.net_effect?.consume?.[0]?.resource?.asset
    const outputAsset = payment.quoted?.output_amount?.asset
    const inputAmount = route?.net_effect?.consume?.[0]?.amount

    const res = await fetch('https://v2.prod.halliday.xyz/payments/quotes', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: { kind: 'FIXED_INPUT', fixed_input_amount: { asset: inputAsset, amount: inputAmount }, output_asset: outputAsset },
        price_currency: 'USD'
      })
    })
    return res.json()
  }

  async function acceptQuote(quoteData) {
    const q = quoteData.quotes[0]
    const res = await fetch('https://v2.prod.halliday.xyz/payments/confirm', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_id: q.payment_id,
        state_token: quoteData.state_token,
        owner_address: userAddress,
        destination_address: userAddress
      })
    })
    return res.json()
  }

  async function getStatus(paymentId) {
    const res = await fetch(`https://v2.prod.halliday.xyz/payments?payment_id=${paymentId}`, {
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY }
    })
    return res.json()
  }

  async function handleRetry() {
    setLoading(true)
    const quoteData = await getQuote(selectedPayment)
    const accepted = await acceptQuote(quoteData)
    setRetryStatus(accepted)

    intervalRef.current = setInterval(async () => {
      const status = await getStatus(accepted.payment_id)
      setRetryStatus(status)
      if (status.status === 'COMPLETE') clearInterval(intervalRef.current)
    }, 3000)

    // Sign and submit the retry
    const typedDataRes = await fetch('https://v2.prod.halliday.xyz/payments/withdraw', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_id: selectedPayment.payment_id,
        token_amounts: balances?.balance_results?.filter((b) => +b.value.amount > 0).map((b) => ({ token: b.token, amount: b.value.amount })) || [],
        recipient_address: accepted.processing_addresses[0].address
      })
    })
    const typedData = await typedDataRes.json()
    const { domain, types, message } = JSON.parse(typedData.withdraw_authorization)
    delete types.EIP712Domain

    const provider = new ethers.BrowserProvider(window.ethereum)
    const signer = await provider.getSigner()
    const signature = await signer.signTypedData(domain, types, message)

    await fetch('https://v2.prod.halliday.xyz/payments/withdraw/confirm', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_id: selectedPayment.payment_id,
        token_amounts: balances?.balance_results?.filter((b) => +b.value.amount > 0).map((b) => ({ token: b.token, amount: b.value.amount })) || [],
        recipient_address: accepted.processing_addresses[0].address,
        owner_signature: signature
      })
    })
    setLoading(false)
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
        <div className="back-button" onClick={() => { clearInterval(intervalRef.current); setScreen('selection'); setRetryStatus(null) }}>←</div>
        <h2 className="text-center">Retry Payment</h2>
        <div className="payment-info-card">
          <span className="payment-type">{info.type} ({info.status})</span>
          <span>{info.input} → {info.output} via {info.provider}</span>
          <span>Stuck: {selectedPayment.stuck}</span>
          <span>{info.time}</span>
        </div>
        <p className="info-label">No user gas tokens are spent when executing a retry payment.</p>

        {retryStatus ? (
          <>
            <span className="workflow-detail-label">Payment ID:</span>
            <span className="workflow-detail-value">{retryStatus.payment_id}</span>
            <br />
            <span className="workflow-detail-label">Status:</span>
            <span className="workflow-detail-value">{retryStatus.status}</span>
            <br />
            {retryStatus.fulfilled?.route && (
              <>
                <span className="workflow-detail-label">Steps:</span>
                <ul>
                  {retryStatus.fulfilled.route.map((step, i) => (
                    <li key={i}>{step.type}: {step.status}</li>
                  ))}
                </ul>
              </>
            )}
            {retryStatus.status !== 'COMPLETE' && <div className="loading-spinner" />}
          </>
        ) : (
          <button
            className={`button enabled ${loading ? 'loading' : ''}`}
            onClick={handleRetry}
            disabled={loading}
          >
            Sign & Retry Payment
          </button>
        )}
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
