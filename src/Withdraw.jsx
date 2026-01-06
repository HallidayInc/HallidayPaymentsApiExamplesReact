import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ethers } from 'ethers'

const HALLIDAY_API_KEY = import.meta.env.VITE_HALLIDAY_API_KEY

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

  useEffect(() => {
    if (!HALLIDAY_API_KEY) alert('VITE_HALLIDAY_API_KEY is missing in .env!')
    loadMetadata()
    checkExistingConnection()
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

  async function handleWithdraw(balance, paymentId) {
    const res = await fetch('https://v2.prod.halliday.xyz/payments/withdraw', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_id: paymentId,
        token_amounts: [{ token: balance.token, amount: balance.value.amount }],
        recipient_address: userAddress
      })
    })
    const typedData = await res.json()
    const { domain, types, message } = JSON.parse(typedData.withdraw_authorization)
    delete types.EIP712Domain

    const provider = new ethers.BrowserProvider(window.ethereum)
    const signer = await provider.getSigner()
    const signature = await signer.signTypedData(domain, types, message)

    const confirmRes = await fetch('https://v2.prod.halliday.xyz/payments/withdraw/confirm', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_id: paymentId,
        token_amounts: [{ token: balance.token, amount: balance.value.amount }],
        recipient_address: userAddress,
        owner_signature: signature
      })
    })
    const { transaction_hash } = await confirmRes.json()
    setTxHashes((prev) => ({ ...prev, [balance.token]: transaction_hash }))
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
                  onClick={() => handleWithdraw(balance, selectedPayment.payment_id)}
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
