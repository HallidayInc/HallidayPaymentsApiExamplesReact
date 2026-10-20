import { useState, useEffect } from 'react'
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

export default function Withdraw() {
  const [screen, setScreen] = useState('selection')
  const [userAddress, setUserAddress] = useState('')
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedPayment, setSelectedPayment] = useState(null)
  const [balances, setBalances] = useState(null)
  const [assets, setAssets] = useState({})
  const [chains, setChains] = useState({})
  const [txHashes, setTxHashes] = useState({})

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

  async function handleWithdraw(balance) {
    try {
      const typedData = await api('/payments/withdraw', {
        withdraw_from: balance.withdraw_from,
        token_amounts: [{ token: balance.token, amount: balance.value.amount }],
        recipient_address: userAddress
      })
      const { domain, types, message } = JSON.parse(typedData.withdraw_authorization)
      delete types.EIP712Domain

      const provider = new ethers.BrowserProvider(window.ethereum)
      const signer = await provider.getSigner()
      const signature = await signer.signTypedData(domain, types, message)

      let withdrawal = await api('/payments/withdraw/confirm', { signature, state_token: typedData.state_token })
      while (withdrawal.status === 'PENDING') {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        withdrawal = await api(`/payments/withdraw/status?withdraw_id=${withdrawal.withdraw_id}`)
      }
      if (withdrawal.status !== 'SUCCESS') throw new Error('Withdrawal did not succeed: ' + JSON.stringify(withdrawal))
      setTxHashes((prev) => ({ ...prev, [balance.token]: withdrawal.transaction_hash }))
    } catch (err) {
      alert(err.message)
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
        <div className="back-button" onClick={() => setScreen('selection')}>←</div>
        <h2 className="text-center">Payment Withdrawal</h2>
        <div className="payment-info-card">
          <span className="payment-type">{info.type} ({info.status})</span>
          <span>{info.input} → {info.output} via {info.provider}</span>
          <span>Stuck: {selectedPayment.stuck}</span>
          <span>{info.time}</span>
        </div>
        <p className="info-label">No user gas tokens are spent when executing a withdrawal.</p>
        <div>
          {balances?.balance_results?.filter((b) => +b.value.amount > 0).map((balance) => {
            const chain = balance.token.split(':')[0]
            const explorer = chains[chain]?.explorer
            const txHash = txHashes[balance.token]
            return (
              <div key={balance.token} className="withdrawal-option-card">
                <div className="token-name">{assets[balance.token]?.name || balance.token}</div>
                <div className="token-amount">Amount stuck: {balance.value.amount}</div>
                <div className="transaction">
                  {txHash && <a href={`${explorer}tx/${txHash}`} target="_blank" rel="noreferrer">See Withdraw Transaction</a>}
                </div>
                <button
                  className="small-button"
                  onClick={() => handleWithdraw(balance)}
                  disabled={!!txHash}
                >
                  Sign & Submit Withdrawal
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
      <h2 className="text-center">Payment Withdrawal</h2>
      <p className="info-label">Withdraw an incomplete payment using the payment's owner wallet. Try with an EIP-1193 wallet like MetaMask, Rabby, or Phantom.</p>

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
                  Withdraw
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
