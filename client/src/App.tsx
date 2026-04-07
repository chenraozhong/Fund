import { useEffect } from 'react'
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

function useSwipeBack() {
  useEffect(() => {
    let startX = 0, startY = 0, startTime = 0
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0]
      startX = t.clientX; startY = t.clientY; startTime = Date.now()
    }
    const onEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0]
      const dx = t.clientX - startX
      const dy = Math.abs(t.clientY - startY)
      const dt = Date.now() - startTime
      // 从左边缘起始(< 40px) + 右滑 > 80px + 水平为主 + 快速滑动(< 400ms)
      if (startX < 40 && dx > 80 && dy < dx * 0.5 && dt < 400) {
        window.history.back()
      }
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
    }
  }, [])
}

export default function App() {
  const Router = import.meta.env.VITE_HARMONY ? HashRouter : BrowserRouter
  useSwipeBack()

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
