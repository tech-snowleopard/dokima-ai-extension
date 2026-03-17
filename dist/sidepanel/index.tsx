import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ExtensionState, TranscriptData } from '@/shared/types'
import { STORAGE_KEYS } from '@/shared/constants'
import { analyzeUnifiedTranscript, type AnalysisResult } from '@/shared/lib/analysis'
import { getSettings, setDemoMode, setDevMode, type Settings } from '@/shared/lib/settings'
import { supabase, getSession, signInWithPassword, signInWithMagicLink, signOut, openDashboardWithAuth } from '@/shared/lib/supabase'
import { DashboardView, DEMO_DASHBOARD_DATA, type DashboardData } from './components/dashboard'
import { AnalysisLaunchScreen } from './components/AnalysisLaunchScreen'

import './styles.css'

// Icons
const PathIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="19" r="3" />
    <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
    <circle cx="18" cy="5" r="3" />
  </svg>
)

const MinimizeIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const ExternalLinkIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

type AuthState = 'loading' | 'unauthenticated' | 'magic_link_sent' | 'authenticated'
type AuthMode = 'password' | 'magic_link'

// Activity name mapping: backend enum -> display label
const ACTIVITY_LABELS: Record<string, string> = {
  intro_roundtable: 'Intro',
  qualify_project: 'Qualify Project',
  qualify_sales_cycle: 'Qualify Sales',
  pitch: 'Pitch',
  show_product: 'Show Product',
  next_steps: 'Next Steps'
}

// Activity name -> CSS color class
const ACTIVITY_COLOR_CLASSES: Record<string, string> = {
  intro_roundtable: 'intro',
  qualify_project: 'qualify-project',
  qualify_sales_cycle: 'qualify-sales',
  pitch: 'pitch',
  show_product: 'show-product',
  next_steps: 'next-steps'
}

// Meeting type -> display label
const MEETING_TYPE_LABELS: Record<string, string> = {
  outbound_prospection: 'Outbound Prospection',
  inbound_qualification: 'Inbound Qualification',
  sales_discovery: 'Sales Discovery',
  demo_meeting: 'Demo Meeting',
  deal_progress: 'Deal Progress',
  other: 'Other',
}

// Transform API AnalysisResult to DashboardData for the new UI
function transformAnalysisToDashboardData(
  analysis: AnalysisResult,
  transcript: TranscriptData
): DashboardData {
  // Build activities from backend data
  const backendActivities = analysis.level2?.playbook_details?.activities || []
  const activitiesDurationSum = backendActivities.reduce((sum, a) => sum + a.duration_seconds, 0)
  // Use the max of backend call duration vs sum of activities to prevent overflow beyond 100%
  const totalDurationSeconds = Math.max(analysis.call_duration_seconds || 0, activitiesDurationSum) || 1

  let cumulativePercent = 0
  const activities: DashboardData['activities'] = backendActivities.map(activity => {
    const widthPercent = Math.round((activity.duration_seconds / totalDurationSeconds) * 100)
    const startPercent = cumulativePercent
    cumulativePercent += widthPercent
    const durationMin = Math.round(activity.duration_seconds / 60)

    return {
      name: ACTIVITY_LABELS[activity.activity] || activity.activity,
      startPercent,
      widthPercent,
      duration: `${durationMin} min`,
      colorClass: ACTIVITY_COLOR_CLASSES[activity.activity] || 'intro'
    }
  })

  const totalMinutes = Math.round(totalDurationSeconds / 60)

  return {
    metadata: {
      title: analysis.call_title || transcript.title,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      duration: `${totalMinutes} min`,
      participants: transcript.metadata?.participants?.length || 2,
      meetingType: MEETING_TYPE_LABELS[analysis.meeting_type] || analysis.meeting_type,
      meetingTypeRaw: analysis.meeting_type,
    },
    scores: {
      playbook: analysis.score_playbook,
      dealQualification: analysis.score_qualification != null
        ? Math.round((analysis.score_qualification / 3) * 100)
        : null,
    },
    activities,
    redFlagsCount: analysis.level2?.red_flags?.length ?? analysis.red_flags_count ?? 0,
    totalDuration: `${totalMinutes} min`,
    analysisStatus: analysis.analysis_status,
  }
}

const Sidepanel: React.FC = () => {
  // Auth state
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [authMode, setAuthMode] = useState<AuthMode>('password')
  const [, setUser] = useState<{ email?: string } | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [authLoading, setAuthLoading] = useState(false)

  // App state
  const [state, setState] = useState<ExtensionState>({ status: 'idle' })
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [isExtracting, setIsExtracting] = useState(false)
  const [demoMode, setDemoModeState] = useState(false)
  const [devMode, setDevModeState] = useState(false)
  const [isInIframe, setIsInIframe] = useState(false)

  // Detect if running in iframe
  useEffect(() => {
    setIsInIframe(window.self !== window.top)
  }, [])

  // DPI scaling: reduce root font-size on Windows high-DPI
  // + force container height to viewport (CSS 100% chain unreliable in Chrome sidepanel)
  useEffect(() => {
    function applyScaling() {
      const dpr = window.devicePixelRatio || 1
      const isWindows = /Win/.test(navigator.platform)
      const container = document.querySelector('.sidepanel-container') as HTMLElement

      if (isWindows && dpr > 1.1) {
        const factor = Math.max(0.70, 1.1 / dpr)
        const baseFontSize = 16 * factor
        document.documentElement.style.fontSize = `${baseFontSize}px`
        // Force container to exact viewport height (CSS % chain breaks with font-size override)
        if (container) {
          container.style.height = `${window.innerHeight}px`
        }
        console.log(`[Sidepanel] DPI scaling: fontSize=${baseFontSize.toFixed(1)}px, height=${window.innerHeight}px (dpr: ${dpr})`)
      } else {
        document.documentElement.style.fontSize = ''
        if (container) {
          container.style.height = ''
        }
      }
    }

    applyScaling()
    window.addEventListener('resize', applyScaling)
    const mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    mediaQuery.addEventListener('change', applyScaling)
    return () => {
      window.removeEventListener('resize', applyScaling)
      mediaQuery.removeEventListener('change', applyScaling)
    }
  }, [])

  // Check auth on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const session = await getSession()
        if (session?.user) {
          setUser(session.user)
          setAuthState('authenticated')
        } else {
          setAuthState('unauthenticated')
        }
      } catch (err) {
        console.error('[Sidepanel] Auth check failed:', err)
        setAuthState('unauthenticated')
      }
    }

    checkAuth()

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('[Sidepanel] Auth state changed:', event)
      if (session?.user) {
        setUser(session.user)
        setAuthState('authenticated')
      } else if (event === 'SIGNED_OUT') {
        setUser(null)
        setAuthState('unauthenticated')
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  // Load settings and app state
  useEffect(() => {
    // Load settings
    getSettings().then(settings => {
      setDemoModeState(settings.demoMode)
      setDevModeState(settings.devMode)
    })

    // Listen for settings changes
    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes[STORAGE_KEYS.SETTINGS]) {
        const newSettings = changes[STORAGE_KEYS.SETTINGS].newValue as Settings | undefined
        setDemoModeState(newSettings?.demoMode ?? false)
        setDevModeState(newSettings?.devMode ?? false)
      }
    }
    chrome.storage.onChanged.addListener(handleStorageChange)

    chrome.storage.local.get(STORAGE_KEYS.STATE).then((result) => {
      if (result[STORAGE_KEYS.STATE]) {
        const savedState = result[STORAGE_KEYS.STATE] as ExtensionState
        // Migration: derive transcriptId from transcript.callId if missing (pre-unified states)
        if (savedState.transcript && !savedState.transcriptId) {
          savedState.transcriptId = savedState.transcript.callId || savedState.transcript.id
          console.log('[Sidepanel] Derived missing transcriptId from transcript:', savedState.transcriptId)
        }
        setState(savedState)
      }
      setLoading(false)
    })

    const handleMessage = (message: { type: string; payload?: ExtensionState }) => {
      if (message.type === 'STATE_UPDATED' && message.payload) {
        setState(message.payload)
      }
    }
    chrome.runtime.onMessage.addListener(handleMessage)

    // Listen for messages from parent (when in iframe)
    const handleWindowMessage = (event: MessageEvent) => {
      // Debug: log all messages
      console.log('[Sidepanel] Message received:', event.data)

      // Security check: only accept messages from extension context
      if (event.data.source !== 'salesagents-extension') {
        console.log('[Sidepanel] Message rejected (wrong source):', event.data.source)
        return
      }

      if (event.data.type === 'CLOSE_PANEL_REQUEST') {
        // Send message to parent to close
        window.parent.postMessage({ type: 'CLOSE_PANEL' }, '*')
      } else if (event.data.type === 'EXTRACTION_STARTED') {
        // Extraction started: disable button
        console.log('[Sidepanel] EXTRACTION_STARTED received, disabling button')
        setIsExtracting(true)
      } else if (event.data.type === 'LOADING') {
        // Navigation detected: reset to loading state
        console.log('[Sidepanel] LOADING received (navigation detected), resetting state')
        setIsExtracting(true)
        // CRITICAL: Clear analysis to prevent showing old data
        setState({
          status: 'extracting',
          transcript: undefined,
          analysis: undefined
        })
      } else if (event.data.type === 'DATA_READY') {
        // Reload data from storage and enable button
        console.log('[Sidepanel] DATA_READY received, reloading from storage')
        setIsExtracting(false)
        chrome.storage.local.get(STORAGE_KEYS.STATE).then((result) => {
          if (result[STORAGE_KEYS.STATE]) {
            const savedState = result[STORAGE_KEYS.STATE] as ExtensionState
            // Migration: derive transcriptId if missing
            if (savedState.transcript && !savedState.transcriptId) {
              savedState.transcriptId = savedState.transcript.callId || savedState.transcript.id
              console.log('[Sidepanel] Derived missing transcriptId from transcript:', savedState.transcriptId)
            }
            console.log('[Sidepanel] State reloaded:', savedState.status, savedState.transcript ? 'with transcript' : 'no transcript')
            setState(savedState)
          }
        })
      }
    }
    window.addEventListener('message', handleWindowMessage)

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage)
      chrome.storage.onChanged.removeListener(handleStorageChange)
      window.removeEventListener('message', handleWindowMessage)
    }
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError(null)

    if (!email.trim()) {
      setAuthError('Email requis')
      return
    }

    if (authMode === 'password') {
      if (!password) {
        setAuthError('Mot de passe requis')
        return
      }

      setAuthLoading(true)
      const { error } = await signInWithPassword(email.trim(), password)
      setAuthLoading(false)

      if (error) {
        setAuthError(error.message)
      }
    } else {
      setAuthLoading(true)
      const { error } = await signInWithMagicLink(email.trim())
      setAuthLoading(false)

      if (error) {
        setAuthError(error.message)
      } else {
        setAuthState('magic_link_sent')
      }
    }
  }

  const handleLogout = async () => {
    await signOut()
    setUser(null)
    setAuthState('unauthenticated')
  }

  const handleDemoModeToggle = async () => {
    const newValue = !demoMode
    setDemoModeState(newValue)
    await setDemoMode(newValue)
  }

  const handleDevModeToggle = async () => {
    const newValue = !devMode
    setDevModeState(newValue)
    await setDevMode(newValue)
  }

  const handleAnalyze = async () => {
    console.log('[Sidepanel] handleAnalyze called')
    console.log('[Sidepanel] state.transcript:', state.transcript ? 'present' : 'missing')
    console.log('[Sidepanel] state.transcriptId:', state.transcriptId || 'none')
    console.log('[Sidepanel] state.status:', state.status)

    if (!state.transcript) {
      console.error('[Sidepanel] Cannot analyze: no transcript in state')
      return
    }

    console.log('[Sidepanel] Starting analysis...', state.transcript.sentences?.length, 'sentences')
    setAnalyzing(true)
    try {
      if (!state.transcriptId) {
        console.error('[Sidepanel] Cannot analyze: no transcriptId in state')
        const errorState: ExtensionState = {
          ...state,
          status: 'error',
          error: 'No transcript ID available. Please reopen the call page and try again.'
        }
        setState(errorState)
        await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: errorState })
        return
      }

      console.log('[Sidepanel] Analyzing via unified endpoint, transcriptId:', state.transcriptId)
      const response = await analyzeUnifiedTranscript(state.transcriptId)

      console.log('[Sidepanel] Analysis response:', response.success ? 'success' : 'failed', response.error)

      if (response.success && response.analysis) {
        const newState: ExtensionState = {
          ...state,
          status: 'done',
          analysis: response.analysis
        }
        setState(newState)

        await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: newState })
        chrome.runtime.sendMessage({ type: 'STATE_UPDATED', payload: newState })
        console.log('[Sidepanel] Analysis saved to state')
      } else {
        console.error('[Sidepanel] Analysis failed:', response.error)
        const errorState: ExtensionState = {
          ...state,
          status: 'error',
          error: response.error || 'Analysis failed'
        }
        setState(errorState)
        await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: errorState })
      }
    } catch (error) {
      console.error('[Sidepanel] Analysis error:', error)
      const errorState: ExtensionState = {
        ...state,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
      setState(errorState)
      await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: errorState })
    } finally {
      setAnalyzing(false)
      console.log('[Sidepanel] Analysis complete, analyzing flag reset')
    }
  }

  const transcript = state.transcript
  const analysis = state.analysis

  // Loading state
  if (loading || authState === 'loading') {
    return (
      <div className="sidepanel-container">
        <div className="loading">Chargement...</div>
      </div>
    )
  }

  // Magic link sent
  if (authState === 'magic_link_sent') {
    return (
      <div className="sidepanel-container">
        <div className="auth-container">
          <div className="auth-header">
            <div className="auth-logo"><PathIcon /></div>
            <h1>DOKIMA AI</h1>
          </div>
          <div className="success-message">
            <p>Lien de connexion envoye a</p>
            <p className="email-sent">{email}</p>
            <p className="hint">Verifiez votre boite mail et cliquez sur le lien.</p>
          </div>
          <button className="secondary-btn" onClick={() => setAuthState('unauthenticated')}>
            Retour
          </button>
        </div>
      </div>
    )
  }

  // Unauthenticated - Login form
  if (authState === 'unauthenticated') {
    return (
      <div className="sidepanel-container">
        <div className="auth-container">
          <div className="auth-header">
            <div className="auth-logo"><PathIcon /></div>
            <h1>DOKIMA AI</h1>
          </div>
          <p className="subtitle">Sales Playbook Enforced. Pre-built.</p>

          <form onSubmit={handleLogin} className="auth-form">
            <input
              type="email"
              placeholder="Votre email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            {authMode === 'password' && (
              <input
                type="password"
                placeholder="Mot de passe"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
            {authError && <p className="error-message">{authError}</p>}
            <button type="submit" className="primary-btn" disabled={authLoading}>
              {authLoading ? 'Connexion...' : (authMode === 'password' ? 'Se connecter' : 'Recevoir le lien')}
            </button>
          </form>

          <button
            className="link-btn"
            onClick={() => {
              setAuthMode(authMode === 'password' ? 'magic_link' : 'password')
              setAuthError(null)
            }}
          >
            {authMode === 'password' ? 'Utiliser Magic Link' : 'Utiliser mot de passe'}
          </button>
        </div>
      </div>
    )
  }

  // Determine full scoring handler
  const handleFullScoringClick = async () => {
    if (demoMode) {
      console.log('[Sidepanel] Go to Full Scoring clicked (demo mode)')
      await openDashboardWithAuth('/dashboard/call/mock-1')
      window.close()
    } else if (analysis?.analysis_id) {
      console.log('[Sidepanel] Go to Full Scoring clicked, analysis_id:', analysis.analysis_id)
      await openDashboardWithAuth(`/dashboard/call/${analysis.analysis_id}`)
    } else {
      console.log('[Sidepanel] Go to Full Scoring clicked, no analysis_id, fallback to dashboard')
      await openDashboardWithAuth('/dashboard')
    }
  }

  // Determine dashboard data
  const dashboardData = demoMode
    ? DEMO_DASHBOARD_DATA
    : (analysis && transcript)
      ? transformAnalysisToDashboardData(analysis, transcript)
      : null

  const showDashboard = dashboardData !== null
  const handleClosePanel = () => window.parent.postMessage({ type: 'CLOSE_PANEL' }, '*')

  // Authenticated - Main app with fixed header + scrollable content + fixed footer
  return (
    <div className="sidepanel-container">
      {/* Fixed Header */}
      <header className="panel-header">
        <div className="panel-header-left">
          <div className="panel-header-logo">
            <PathIcon />
          </div>
          <span className="panel-header-brand">DOKIMA AI</span>
        </div>
        {isInIframe && (
          <button className="panel-header-close-btn" onClick={handleClosePanel} title="Close">
            <MinimizeIcon />
          </button>
        )}
      </header>

      {/* Scrollable Content */}
      <main className="panel-scrollable-content">
        {showDashboard ? (
          <DashboardView data={dashboardData} />
        ) : isInIframe || transcript ? (
          <AnalysisLaunchScreen
            onAnalyze={handleAnalyze}
            isAnalyzing={analyzing}
            isExtracting={isExtracting}
          />
        ) : (
          <div className="empty-state">
            <p>Ouvrez une page de call Fireflies ou Modjo et cliquez sur "Analyser".</p>
            <p className="hint">Le transcript sera analyse automatiquement.</p>
          </div>
        )}
      </main>

      {/* Fixed "Go to full scoring" button - only when dashboard is shown */}
      {showDashboard && (
        <div className="full-scoring-bar">
          <button className="btn-full-width" onClick={handleFullScoringClick}>
            <ExternalLinkIcon />
            Go to full scoring
          </button>
        </div>
      )}

      {/* Fixed Footer */}
      <footer className="app-footer">
        <div className="footer-toggles">
          <label className="demo-toggle-footer">
            <input
              type="checkbox"
              checked={demoMode}
              onChange={handleDemoModeToggle}
            />
            <span>Demo</span>
          </label>
          <label className="demo-toggle-footer">
            <input
              type="checkbox"
              checked={devMode}
              onChange={handleDevModeToggle}
            />
            <span>Dev</span>
          </label>
        </div>
        {!showDashboard && (
          <button
            className="analyze-btn-footer"
            onClick={handleAnalyze}
            disabled={!transcript || analyzing}
          >
            {analyzing ? 'Analyse...' : analysis ? 'Re-analyser' : 'Analyser'}
          </button>
        )}
        <button className="logout-btn-footer" onClick={handleLogout} title="Deconnexion">
          Logout
        </button>
      </footer>
    </div>
  )
}

const container = document.getElementById('root')
if (container) {
  const root = createRoot(container)
  root.render(<Sidepanel />)
}
