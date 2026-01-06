import { Routes, Route, Link } from 'react-router-dom'
import Onramp from './Onramp'
import Swap from './Swap'
import Withdraw from './Withdraw'
import Retry from './Retry'

function Home() {
  return (
    <div className="container short home-container">
      <h2 className="text-center">Halliday API Examples</h2>
      <nav className="nav-links">
        <Link to="/onramp">
          Onramp
          <div className="description">Convert USD to crypto tokens</div>
        </Link>
        <Link to="/swap">
          Swap
          <div className="description">Cross-chain token swaps</div>
        </Link>
        <Link to="/withdraw">
          Withdraw
          <div className="description">Recover stuck tokens</div>
        </Link>
        <Link to="/retry">
          Retry
          <div className="description">Retry failed payments</div>
        </Link>
      </nav>
      <div className="powered-by">Powered by Halliday</div>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/onramp" element={<Onramp />} />
      <Route path="/swap" element={<Swap />} />
      <Route path="/withdraw" element={<Withdraw />} />
      <Route path="/retry" element={<Retry />} />
    </Routes>
  )
}
