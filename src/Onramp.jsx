import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ethers } from 'ethers'

const HALLIDAY_API_KEY = import.meta.env.VITE_HALLIDAY_API_KEY
const INPUT_ASSET = 'usd'
const OUTPUT_ASSET = 'megaeth:0x28b7e77f82b25b95953825f1e3ea0e36c1c29861'
const ONRAMPS = ['stripe', 'transak', 'moonpay']

export default function Onramp() {
  const [screen, setScreen] = useState('input')
  const [payAmount, setPayAmount] = useState('')
  const [address, setAddress] = useState('')
  const [selectedOnramp, setSelectedOnramp] = useState('stripe')
  const [quotes, setQuotes] = useState({})
  const [loading, setLoading] = useState(false)
  const [iframeUrl, setIframeUrl] = useState('')
  const timeoutRef = useRef(null)

  useEffect(() => {
    if (!HALLIDAY_API_KEY) alert('VITE_HALLIDAY_API_KEY is missing in .env!')
  }, [])

  const isValidAddress = (addr) => /^0x[a-fA-F0-9]{40}$/.test(addr)
  const currentQuote = quotes[selectedOnramp] || {}
  const outputAmount = parseFloat(currentQuote.outputAmount) || 0
  const isEnabled = outputAmount > 0 && isValidAddress(address) && !loading

  async function getQuote(inputAmount) {
    const res = await fetch('https://v2.prod.halliday.xyz/payments/quotes', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + HALLIDAY_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        request: {
          kind: 'FIXED_INPUT',
          fixed_input_amount: { asset: INPUT_ASSET, amount: inputAmount },
          output_asset: OUTPUT_ASSET,
        },
        price_currency: 'usd',
        onramps: ONRAMPS,
        onramp_methods: ['CREDIT_CARD'],
        customer_geolocation: { alpha3_country_code: 'USA' }
      }),
    })
    const data = await res.json()
    const newQuotes = {}
    data.quotes?.forEach((q) => {
      newQuotes[q.onramp] = {
        stateToken: data.state_token,
        paymentId: q.payment_id,
        outputAmount: q.output_amount.amount,
        price: (inputAmount / +q.output_amount.amount).toFixed(2),
        fees: (+q.fees.total_fees).toFixed(3),
        aggPrice: (+data.current_prices[OUTPUT_ASSET]).toFixed(2),
      }
    })
    setQuotes(newQuotes)
  }

  async function acceptQuote() {
    const quote = quotes[selectedOnramp]
    const res = await fetch('https://v2.prod.halliday.xyz/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + HALLIDAY_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        payment_id: quote.paymentId,
        state_token: quote.stateToken,
        owner_address: address,
        destination_address: address
      })
    })
    return res.json()
  }

  function handleAmountChange(e) {
    const value = e.target.value
    if (!/^[0-9]*\.?[0-9]*$/.test(value)) return
    setPayAmount(value)
    if (!value || value === '0') return

    setLoading(true)
    clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(async () => {
      await getQuote(value)
      setLoading(false)
    }, 2000)
  }

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

    const verifyRes = await fetch('https://v2.prod.halliday.xyz/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + HALLIDAY_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ verification_token, signatures })
    })

    if (verifyRes.status === 409) return confirmResult
    if (verifyRes.status === 400) throw new Error('Quote expired. Please try again.')
    if (verifyRes.status === 401) throw new Error('Signature verification failed. Please try again.')

    return verifyRes.json()
  }

  async function handleContinue() {
    if (!isEnabled) return
    setLoading(true)

    try {
      let confirmResult = await acceptQuote()

      // Handle USER_VERIFY loop (owner verify >= $300, withdrawal sim >= $1M)
      while (confirmResult.next_instruction?.type === 'USER_VERIFY') {
        if (!window.ethereum) {
          alert('Wallet required to sign verification. Install MetaMask.')
          setLoading(false)
          return
        }
        confirmResult = await handleVerification(confirmResult)
      }

      setIframeUrl(confirmResult.next_instruction.funding_page_url)
      setScreen('onramp')
    } catch (err) {
      alert(err.message)
    }

    setLoading(false)
  }

  if (screen === 'onramp') {
    return (
      <div className="container">
        <div className="back-button" onClick={() => setScreen('input')}>←</div>
        <iframe className="onramp-iframe" src={iframeUrl} />
        <div className="powered-by">Powered by Halliday</div>
      </div>
    )
  }

  return (
    <div className="container">
      <Link to="/" className="back-button">←</Link>
      <h2 className="text-center">Onramp to MEGA</h2>

      <div className="radio-group">
        {ONRAMPS.map((onramp) => (
          <div className="radio-option" key={onramp}>
            <input
              type="radio"
              id={onramp}
              name="provider"
              value={onramp}
              checked={selectedOnramp === onramp}
              onChange={(e) => setSelectedOnramp(e.target.value)}
            />
            <label htmlFor={onramp}>{onramp.charAt(0).toUpperCase() + onramp.slice(1)}</label>
          </div>
        ))}
      </div>

      <div className="input-section">
        <div className="input-label">You pay</div>
        <div className="input-container">
          <input
            className="amount-input"
            type="text"
            placeholder="-"
            autoComplete="off"
            value={payAmount}
            onChange={handleAmountChange}
          />
          <div className="currency-label">
            USD <span className="token-icon usa-icon" />
          </div>
        </div>
      </div>

      <div className="output-section">
        <div className="output-label">You receive</div>
        <div className="output-container">
          <div className="output-amount">{outputAmount > 0 ? outputAmount.toFixed(6) : '-'}</div>
          <div className="output-usd">
            {currentQuote.price ? (
              <>
                ${currentQuote.price} per token, Total fees ${currentQuote.fees}.<br />
                MEGA price ${currentQuote.aggPrice}.
              </>
            ) : '$-'}
          </div>
          <div className="output-currency">
            MEGA <img src="https://coin-images.coingecko.com/coins/images/69995/large/ICON.png?1760337992" alt="MEGA" className="token-icon" />
          </div>
        </div>
      </div>

      <div className="confirm-content">
        <div className="input-label">
          Wallet address to onramp MEGA to on MegaETH. This wallet address will own the payment, <a href="https://docs.halliday.xyz/pages/otw" target="_blank" rel="noreferrer">learn more here</a>.
        </div>
        <input
          className="address-input"
          type="text"
          placeholder="0x..."
          autoComplete="off"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
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
