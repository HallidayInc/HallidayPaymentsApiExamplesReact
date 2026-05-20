import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ethers } from 'ethers'

const HALLIDAY_API_KEY = import.meta.env.VITE_HALLIDAY_API_KEY
const FROM_CHAIN_ID = '0x2105' // Base mainnet
const INPUT_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // USDC on Base
const INPUT_ASSET = 'base:' + INPUT_TOKEN
const OUTPUT_ASSET = 'megaeth:0x28b7e77f82b25b95953825f1e3ea0e36c1c29861'
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
]

export default function Swap() {
  const [screen, setScreen] = useState('input')
  const [userAddress, setUserAddress] = useState('')
  const [balance, setBalance] = useState('')
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState({})
  const [loading, setLoading] = useState(false)
  const [swapData, setSwapData] = useState(null)
  const [swapStatus, setSwapStatus] = useState(null)
  const timeoutRef = useRef(null)
  const intervalRef = useRef(null)

  useEffect(() => {
    if (!HALLIDAY_API_KEY) alert('VITE_HALLIDAY_API_KEY is missing in .env!')
    checkExistingConnection()
    return () => clearInterval(intervalRef.current)
  }, [])

  async function checkExistingConnection() {
    if (!window.ethereum) return
    const accounts = await window.ethereum.request({ method: 'eth_accounts' })
    if (accounts.length) {
      setUserAddress(accounts[0])
      await showBalance(accounts[0])
    }
  }

  async function showBalance(address) {
    const chainId = await window.ethereum.request({ method: 'eth_chainId' })
    if (chainId !== FROM_CHAIN_ID) {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: FROM_CHAIN_ID }] })
    }
    const provider = new ethers.BrowserProvider(window.ethereum)
    const contract = new ethers.Contract(INPUT_TOKEN, ERC20_ABI, provider)
    const [bal, decimals] = await Promise.all([contract.balanceOf(address), contract.decimals()])
    setBalance(ethers.formatUnits(bal, decimals))
  }

  async function connectWallet() {
    if (!window.ethereum) return alert('No wallet found. Install MetaMask.')
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
    setUserAddress(accounts[0])
    await showBalance(accounts[0])
  }

  async function disconnect() {
    await window.ethereum.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
    setUserAddress('')
    setBalance('')
  }

  async function getQuote(inputAmount) {
    const res = await fetch('https://v2.prod.halliday.xyz/payments/quotes', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: { kind: 'FIXED_INPUT', fixed_input_amount: { asset: INPUT_ASSET, amount: inputAmount }, output_asset: OUTPUT_ASSET },
        price_currency: 'USD'
      })
    })
    const data = await res.json()
    if (data.quotes?.[0]) {
      setQuote({
        stateToken: data.state_token,
        paymentId: data.quotes[0].payment_id,
        outputAmount: data.quotes[0].output_amount.amount,
        price: (inputAmount / +data.quotes[0].output_amount.amount).toFixed(2)
      })
    }
  }

  async function acceptQuote() {
    const res = await fetch('https://v2.prod.halliday.xyz/payments/confirm', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HALLIDAY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_id: quote.paymentId,
        state_token: quote.stateToken,
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

  function handleAmountChange(e) {
    const value = e.target.value
    if (!/^[0-9]*\.?[0-9]*$/.test(value)) return
    setAmount(value)
    if (!value || value === '0') return

    setLoading(true)
    clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(async () => {
      await getQuote(value)
      setLoading(false)
    }, 2000)
  }

  async function handleContinue() {
    if (!isEnabled) return
    setLoading(true)
    const data = await acceptQuote()
    setSwapData(data)
    setScreen('swap')

    intervalRef.current = setInterval(async () => {
      const status = await getStatus(data.payment_id)
      setSwapStatus(status)
    }, 5000)

    // Fund the swap
    const fundAmount = data.quoted.route[0].net_effect.consume[0].amount
    const fundAddress = data.processing_addresses[0].address
    const provider = new ethers.BrowserProvider(window.ethereum)
    const signer = await provider.getSigner()
    const contract = new ethers.Contract(INPUT_TOKEN, ERC20_ABI, signer)
    const decimals = await contract.decimals()
    const tx = await contract.transfer(fundAddress, ethers.parseUnits(fundAmount, decimals))
    await tx.wait()
    setLoading(false)
  }

  const outputAmount = parseFloat(quote.outputAmount) || 0
  const isEnabled = outputAmount > 0 && userAddress && !loading
  const exceedsBalance = balance && +amount > +balance

  if (screen === 'swap') {
    return (
      <div className="container">
        <div className="back-button" onClick={() => { clearInterval(intervalRef.current); setScreen('input') }}>←</div>
        <h2 className="text-center">Cross-Chain Swap</h2>
        <span className="workflow-detail-label">Last Update:</span>
        <span className="workflow-detail-value">{swapStatus?.updated_at || '-'}</span>
        <br />
        <span className="workflow-detail-label">ID:</span>
        <span className="workflow-detail-value">{swapData?.payment_id}</span>
        <br />
        <span className="workflow-detail-label">Swap Steps:</span>
        <ul>
          {swapStatus?.fulfilled?.route?.map((step, i) => (
            <li key={i}>{step.type}: {step.status}</li>
          ))}
        </ul>
        <span className="workflow-detail-label">Swap Status:</span>
        <span className="workflow-detail-value">{swapStatus?.status || 'PENDING'}</span>
        <br />
        <span className="workflow-detail-label">Context:</span>
        <span className="workflow-detail-value">
          {swapStatus?.status === 'COMPLETE'
            ? 'Complete! Check the destination chain for your tokens.'
            : 'Check the browser console logs for more information'}
        </span>
        {swapStatus?.status !== 'COMPLETE' && <div className="swap-loading-spinner loading-spinner" />}
        <div className="powered-by sink">Powered by Halliday</div>
      </div>
    )
  }

  return (
    <div className="container">
      <Link to="/" className="back-button">←</Link>
      <h2 className="text-center">Cross-Chain Swap</h2>

      <div className="connect-wallet-container">
        {!userAddress ? (
          <button className="button enabled" onClick={connectWallet}>Connect Wallet</button>
        ) : (
          <p className="info-label">
            Connected wallet address to perform swap:
            <br />
            <span className="address-label">{userAddress}</span>
            <br />
            <button className="disconnect" onClick={disconnect}>Disconnect</button>
          </p>
        )}
      </div>

      <div className="input-section">
        <div className="input-label">You pay</div>
        <div className="input-container">
          <input
            className={`amount-input ${exceedsBalance ? 'red-text' : ''}`}
            type="text"
            placeholder="-"
            autoComplete="off"
            value={amount}
            onChange={handleAmountChange}
          />
          <div className="input-available">Available in Wallet: {balance || '-'}</div>
          <div className="currency-label">
            Base USDC <span className="token-icon usdc-icon" />
          </div>
        </div>
      </div>

      <div className="output-section">
        <div className="output-label">You receive</div>
        <div className="output-container">
          <div className="output-amount">{outputAmount > 0 ? outputAmount.toFixed(6) : '-'}</div>
          <div className="output-usd">{quote.price ? `$${quote.price} per token` : '$-'}</div>
          <div className="output-currency">
            MEGA <img src="https://coin-images.coingecko.com/coins/images/69995/large/ICON.png?1760337992" alt="MEGA" className="token-icon" />
          </div>
        </div>
      </div>

      <div className="terms-container">
        <label className="terms-label">
          By clicking Continue, I accept the <a href="https://halliday.xyz/legal/terms-of-use" target="_blank" rel="noreferrer">Halliday Terms & Conditions</a>.
        </label>
      </div>

      <button
        className={`button ${isEnabled ? 'enabled' : ''} ${loading ? 'loading' : ''}`}
        onClick={handleContinue}
        disabled={!isEnabled}
      >
        Continue
      </button>
      <div className="powered-by">Powered by Halliday</div>
    </div>
  )
}
