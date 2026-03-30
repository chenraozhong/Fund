import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Performance from './pages/Performance'
import Transactions from './pages/Transactions'
import Funds from './pages/Funds'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/performance" element={<Performance />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/funds" element={<Funds />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
