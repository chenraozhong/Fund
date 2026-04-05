import { BrowserRouter, HashRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Performance from './pages/Performance'
import Transactions from './pages/Transactions'
import Funds from './pages/Funds'
import FundDetail from './pages/FundDetail'
import Backups from './pages/Backups'
import Import from './pages/Import'
import Sync from './pages/Sync'
import Portfolio from './pages/Portfolio'

export default function App() {
  const Router = import.meta.env.VITE_HARMONY ? HashRouter : BrowserRouter

  return (
    <Router>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/performance" element={<Performance />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/funds" element={<Funds />} />
          <Route path="/funds/:id" element={<FundDetail />} />
          <Route path="/backups" element={<Backups />} />
          <Route path="/import" element={<Import />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/sync" element={<Sync />} />
        </Route>
      </Routes>
    </Router>
  )
}
