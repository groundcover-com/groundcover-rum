import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router'
import {
  AlertCircle,
  Bug,
  Globe,
  GlobeLock,
  LineChart,
  MousePointer,
  Terminal,
  User,
  Navigation,
  Play,
  Square,
  RefreshCw,
  Hash,
  Video,
  VideoOff,
  Tag,
  MessageSquare,
  Layers
} from 'lucide-react'
import './App.css'
import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.tsx'
import groundcover from '@groundcover/browser'
import axios from 'axios'

function App({ title }: { title?: string }) {
  const navigate = useNavigate()
  const [networkRequest, setNetworkRequest] = useState({
    url: 'https://api.example.com',
    method: 'GET',
    type: 'fetch',
    body: ''
  })
  const [navigationState, setNavigationState] = useState<{
    isActive: boolean;
    startTime?: number;
    metadata?: Record<string, unknown>;
  }>({ isActive: false })
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [sessionIdHistory, setSessionIdHistory] = useState<string[]>([])
  const [customSessionId, setCustomSessionId] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null)

  // Canvas chart: chart series are drawn to a <canvas> (2D context), while
  // labels/axes are DOM — mirrors a typical charting UI so we can exercise opt-in
  // session-replay canvas capture (options.replay.canvas). rrweb records the
  // surrounding DOM but not the canvas pixels unless canvas capture is enabled.
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const drawChart = useCallback(() => {
    // Guard context availability and contain any canvas failure — a browser/DOM
    // error must not escape the mount effect or the click handler.
    try {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return

      const { width, height } = canvas
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)

      // Random bar series so each redraw produces a visibly different frame.
      const bars = 12
      const gap = 6
      const barWidth = (width - gap * (bars + 1)) / bars
      for (let i = 0; i < bars; i++) {
        const value = 0.15 + Math.random() * 0.8
        const barHeight = value * (height - 20)
        const x = gap + i * (barWidth + gap)
        const y = height - barHeight
        ctx.fillStyle = `hsl(${(i * 360) / bars}, 70%, 55%)`
        ctx.fillRect(x, y, barWidth, barHeight)
      }

      // A line overlay so both stroke and fill paths are exercised.
      ctx.strokeStyle = '#0f172a'
      ctx.lineWidth = 2
      ctx.beginPath()
      for (let i = 0; i <= bars; i++) {
        const x = gap + i * (barWidth + gap)
        const y = height - (0.2 + Math.random() * 0.6) * (height - 20)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    } catch (error) {
      console.error('[playground] canvas draw failed:', error)
    }
  }, [])

  // Draw once on mount so the canvas is never blank.
  useEffect(() => {
    drawChart()
  }, [drawChart])

  // Update timer every second for navigation duration display
  useEffect(() => {
    if (!navigationState.isActive && !isRecording) return

    const interval = setInterval(() => {
      setCurrentTime(Date.now())
    }, 1000)

    return () => clearInterval(interval)
  }, [navigationState.isActive, isRecording])

  const handleNetworkRequest = async () => {
    try {
      if (networkRequest.type === 'fetch') {
        const response = await fetch(networkRequest.url, {
          method: networkRequest.method,
        headers: {
          'Content-Type': 'application/json'
        },
        body: networkRequest.method !== 'GET' ? networkRequest.body : undefined
      })
        const data = await response.json()
        console.log('Network Response:', data)
      } else if (networkRequest.type === 'axios') {
        const config = {
          method: networkRequest.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete',
          url: networkRequest.url,
          headers: {
            'Content-Type': 'application/json'
          },
          ...(networkRequest.method !== 'GET' && networkRequest.body && {
            data: networkRequest.body
          })
        }
        
        const response = await axios(config)
        console.log('Axios Response:', response.data)
      } else {
        const response = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open(networkRequest.method, networkRequest.url, true)
          xhr.setRequestHeader('Content-Type', 'application/json')
          xhr.send(networkRequest.body)

          xhr.onload = () => {
            resolve(xhr.response)
          }

          xhr.onerror = () => {
            reject(new Error('Network request failed'))
          }
        })

        console.log('Network Response:', response)
      }
    } catch (error) {
      console.error('Network Error:', error)
    }
  }

  const simulateError = () => {
    throw new Error('This is a simulated error!')
  }

  const testConsoleError = () => {
    // Logs several error shapes: a plain Error, a renamed one with context, a TypeError
    const basicError = new Error('Database connection failed')
    const customError = new Error('User authentication failed')
    customError.name = 'AuthError'
    
    console.error('🔥 Basic error test:', basicError)
    console.error('🔥 Custom error test:', customError, { userId: 123, action: 'login' })
    console.error('🔥 TypeError test:', new TypeError('Cannot read property of undefined'))
    console.log('✅ Console error tests completed - check network tab for captured logs')
  }

  const testRequestPipeThrough = async () => {
    try {
      console.log('🔄 Testing response.body.pipeThrough() with streaming...')
      
      const res = await fetch("https://jsonplaceholder.typicode.com/posts");
      console.log('📡 Network request completed')

      // The body is a ReadableStream<Uint8Array>
      if (!res.body) {
        throw new Error('Response body is null')
      }
      
      const textStream = res.body
        .pipeThrough(new TextDecoderStream()) // decode bytes → text
        .pipeThrough(new TransformStream({
          transform(chunk, controller) {
            // Example: uppercase all text chunks
            console.log('📥 Processing chunk:', chunk)
            controller.enqueue(chunk.toUpperCase());
          }
        }));

      console.log('🔄 Response body piped through transform streams')

      const reader = textStream.getReader();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        console.log('📖 Transformed chunk:', value);
      }
      
      console.log('✅ Response.pipeThrough test completed')
      console.log('🔍 Check network tab to see how the RUM SDK captures this streaming response')
      
    } catch (error) {
      console.error('❌ Response.pipeThrough test error:', error)
    }
  }

  const trackCustomEvent = () => {
    groundcover.sendCustomEvent({
      event: 'button_click',
      attributes: {
        button_text: 'Click me'
      }
    })
  }

  const emitLoggerWarn = () => {
    groundcover.logger.warn('Playground checkout failed', {
      appId: 'playground',
      environment: 'dev',
      order: { id: 'ord_42', total: 199.99 }
    })
    console.log('✅ logger.warn emitted — check the RUM /json/rum payload for structured attributes')
  }

  const logWithStructuredObject = () => {
    console.log('User action emitted', {
      appId: 'playground',
      environment: 'dev',
      userAction: { type: 'click', target: 'demo-button' }
    })
    console.log('✅ console.log with object emitted — object keys are also queryable as log attributes')
  }

  const simulateDOMEvent = (event: string) => {
    const element = document.body
    const evt = new Event(event, { bubbles: true })
    element.dispatchEvent(evt)
    console.log(`DOM Event '${event}' simulated`)
  }

  const identifyUser = () => {
    groundcover.identifyUser({
      id: '123',
      name: 'John Doe',
      email: 'john.doe@example.com'
    })
  }

  const changeURLParams = () => {
    const url = new URL(window.location.href)
    url.searchParams.set('param1', 'value1')
    url.searchParams.set('param2', 'value2')
    window.history.pushState({}, '', url.toString())
  }

  const updateConfig = () => {
    try {
      groundcover.updateConfig({
        // Local, like main.tsx, unless VITE_GC_DSN / VITE_GC_API_KEY are set (apps/playground/.env.local,
        // git-ignored), so a click sends nothing off the machine by default.
        dsn: import.meta.env.VITE_GC_DSN || "http://localhost:3000",
        apiKey: import.meta.env.VITE_GC_API_KEY || "playground-key",
        cluster: "rum",
        environment: "dev",
        namespace: "playground",
        options: {
          tracing: { propagationUrls: ["https://jsonplaceholder.typicode.com/*"] },
          privacy: { level: "mask-all" },
          transport: { compression: false, batchSize: 7 },
          debug: true,
        },
      })
    } catch (error) {
      console.error("[playground] updateConfig failed:", error)
    }
  }

  const startManualNavigation = () => {
    const metadata = {
      source: 'manual',
      action: 'start_button',
      timestamp: Date.now(),
      user_initiated: true
    }
    
    groundcover.startNavigation(metadata)
    setNavigationState({
      isActive: true,
      startTime: Date.now(),
      metadata
    })
    console.log('📍 Manual navigation started:', metadata)
  }

  const endManualNavigation = () => {
    const metadata = {
      source: 'manual',
      action: 'end_button',
      timestamp: Date.now(),
      duration: navigationState.startTime ? Date.now() - navigationState.startTime : 0
    }
    
    groundcover.endNavigation(metadata)
    setNavigationState({ isActive: false })
    console.log('🏁 Manual navigation ended:', metadata)
  }

  const generateNewSessionId = async () => {
    try {
      await groundcover.setSessionId()
      setSessionIdHistory(prev => [...prev, `Generated new session ID`])
      console.log('🔄 Generated new session ID')
    } catch (error) {
      console.error('❌ Failed to generate new session ID:', error)
      setSessionIdHistory(prev => [...prev, `Failed to generate new session ID`])
    }
  }

  const setCustomSession = async () => {
    if (!customSessionId.trim()) {
      console.warn('Please enter a session ID')
      return
    }
    
    try {
      await groundcover.setSessionId(customSessionId)
      setSessionIdHistory(prev => [...prev, `Set to: ${customSessionId}`])
      console.log('🎯 Set custom session ID:', customSessionId)
      setCustomSessionId('')
    } catch (error) {
      console.error('❌ Failed to set custom session ID:', error)
      setSessionIdHistory(prev => [...prev, `Failed to set: ${customSessionId}`])
    }
  }

  const startSessionReplay = () => {
    try {
      groundcover.startReplayRecording()
      setIsRecording(true)
      setRecordingStartTime(Date.now())
      console.log('🎥 Session replay recording started')
    } catch (error) {
      console.error('❌ Failed to start session replay:', error)
      setIsRecording(false)
      setRecordingStartTime(null)
    }
  }

  const stopSessionReplay = () => {
    try {
      groundcover.stopReplayRecording()
      setIsRecording(false)
      const duration = recordingStartTime ? Date.now() - recordingStartTime : 0
      console.log(`🎬 Session replay recording stopped. Duration: ${duration}ms`)
      setRecordingStartTime(null)
    } catch (error) {
      console.error('❌ Failed to stop session replay:', error)
    }
  }

  const clearSessionHistory = () => {
    setSessionIdHistory([])
  }

  const testCustomHeadersFetch = async () => {
    try {
      console.log('🧪 Testing Fetch custom headers preservation...')

      // Test 1: Fetch with Request object and custom headers
      console.log('Test 1: Fetch with Request object')
      const request = new Request('https://jsonplaceholder.typicode.com/posts/1', {
        method: 'GET',
        headers: {
          'x-custom-header-1': 'value1',
          'x-custom-header-2': 'value2',
          'x-custom-header-3': 'value3'
        }
      })
      await fetch(request)
      console.log('✅ Test 1 completed - check network tab for custom headers')

      // Test 2: Fetch with Request object + additional headers in init
      console.log('Test 2: Fetch with Request object + init headers')
      const request2 = new Request('https://jsonplaceholder.typicode.com/posts/2', {
        method: 'GET',
        headers: {
          'x-request-header': 'from-request'
        }
      })
      await fetch(request2, {
        headers: {
          'x-init-header': 'from-init'
        }
      })
      console.log('✅ Test 2 completed - check network tab (should have both headers)')

      // Test 3: Fetch with plain object headers
      console.log('Test 3: Fetch with plain object headers')
      await fetch('https://jsonplaceholder.typicode.com/posts/3', {
        method: 'GET',
        headers: {
          'x-plain-header-1': 'plain-value1',
          'x-plain-header-2': 'plain-value2'
        }
      })
      console.log('✅ Test 3 completed - check network tab for custom headers')

      // Test 4: Fetch with Headers object
      console.log('Test 4: Fetch with Headers object')
      const headers = new Headers()
      headers.set('x-headers-obj-1', 'headers-value1')
      headers.set('x-headers-obj-2', 'headers-value2')
      await fetch('https://jsonplaceholder.typicode.com/posts/4', {
        method: 'GET',
        headers: headers
      })
      console.log('✅ Test 4 completed - check network tab for custom headers')

      // Test 5: Fetch with array headers
      console.log('Test 5: Fetch with array headers')
      await fetch('https://jsonplaceholder.typicode.com/posts/5', {
        method: 'GET',
        headers: [
          ['x-array-header-1', 'array-value1'],
          ['x-array-header-2', 'array-value2']
        ]
      })
      console.log('✅ Test 5 completed - check network tab for custom headers')

      console.log('✅ All Fetch custom header tests completed!')
      console.log('🔍 Check the network tab in your RUM backend to verify all custom headers were captured')

    } catch (error) {
      console.error('❌ Fetch custom headers test error:', error)
    }
  }

  const testCustomHeadersXHR = async () => {
    try {
      console.log('🧪 Testing XHR custom headers preservation...')

      // Test 1: XHR with multiple custom headers
      console.log('Test 1: XHR with multiple custom headers')
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', 'https://jsonplaceholder.typicode.com/posts/1', true)
        xhr.setRequestHeader('x-xhr-header-1', 'xhr-value1')
        xhr.setRequestHeader('x-xhr-header-2', 'xhr-value2')
        xhr.setRequestHeader('x-xhr-header-3', 'xhr-value3')
        xhr.onload = () => resolve(xhr.response)
        xhr.onerror = () => reject(new Error('XHR failed'))
        xhr.send()
      })
      console.log('✅ Test 1 completed - check network tab for custom headers')

      // Test 2: XHR POST with custom headers and body
      console.log('Test 2: XHR POST with custom headers and body')
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', 'https://jsonplaceholder.typicode.com/posts', true)
        xhr.setRequestHeader('Content-Type', 'application/json')
        xhr.setRequestHeader('x-xhr-post-header', 'post-value')
        xhr.setRequestHeader('x-xhr-custom', 'custom-value')
        xhr.onload = () => resolve(xhr.response)
        xhr.onerror = () => reject(new Error('XHR failed'))
        xhr.send(JSON.stringify({ title: 'Test', body: 'Test body' }))
      })
      console.log('✅ Test 2 completed - check network tab for custom headers')

      // Test 3: XHR with duplicate header names (should use last value)
      console.log('Test 3: XHR with duplicate header name')
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', 'https://jsonplaceholder.typicode.com/posts/2', true)
        xhr.setRequestHeader('x-duplicate-header', 'first-value')
        xhr.setRequestHeader('x-duplicate-header', 'second-value')
        xhr.onload = () => resolve(xhr.response)
        xhr.onerror = () => reject(new Error('XHR failed'))
        xhr.send()
      })
      console.log('✅ Test 3 completed - check network tab (should show combined values)')

      console.log('✅ All XHR custom header tests completed!')
      console.log('🔍 Check the network tab in your RUM backend to verify all custom headers were captured')

    } catch (error) {
      console.error('❌ XHR custom headers test error:', error)
    }
  }

  // --- Privacy testing -----------------------------------------------------
  // These fire events carrying sensitive data so the e2e privacy specs can
  // assert it is redacted across network / logs / errors / DOM / location.
  const sendSensitiveNetworkRequest = async () => {
    try {
      await fetch(
        "https://jsonplaceholder.typicode.com/posts?token=supersecret&page=2&playground_secret=qp&code=oauthcode123&state=csrf456",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer abc123",
            "x-api-key": "key_live_xyz",
            "x-functions-key": "fnkey789",
            "playground_secret": "header-secret",
          },
          body: JSON.stringify({
            username: "bob",
            password: "hunter2",
            card_number: "4111111111111111",
            playground_secret: "body-secret",
            writeKey: "fixture-write-key-0000000",
            nested: { token: "deep-token" },
          }),
        }
      )
      console.log("✅ Sensitive network request sent")
    } catch (error) {
      console.error("❌ Sensitive network request error:", error)
    }
  }

  const logSensitiveData = () => {
    console.log("user login password=hunter2 token=abc123", {
      username: "bob",
      password: "hunter2",
      apiKey: "key_live_xyz",
      playground_secret: "log-secret",
    })
  }

  const captureSensitiveError = () => {
    groundcover.captureException(
      new Error("auth failed token=secret123 for user bob"),
      { userId: "bob", password: "hunter2", playground_secret: "err-secret" }
    )
    console.log("✅ Sensitive error captured")
  }

  const addSensitiveUrlParam = () => {
    const url = new URL(window.location.href)
    // Simulate an OAuth callback URL (?code=…&state=…) plus a token.
    url.searchParams.set("token", "supersecret")
    url.searchParams.set("code", "oauthcode123")
    url.searchParams.set("state", "csrf456")
    url.searchParams.set("page", "2")
    window.history.pushState({}, "", url.toString())
    console.log("✅ Added sensitive URL param")
  }

  // Trigger a flush (batchSize is 10) so the e2e specs don't wait the full
  // batchTimeout for queued privacy events to be sent.
  const flushEvents = () => {
    for (let i = 0; i < 10; i++) console.log(`flush ${i}`)
  }

  return (
    <div className="flex flex-col gap-4 items-center">
      <h1 data-title={title}>{title}</h1>

      {/* Privacy Testing */}
      <div className="flex flex-col items-center gap-2 p-4 border rounded-lg bg-rose-50">
        <h3 className="font-semibold flex items-center gap-2">
          <GlobeLock className="w-4 h-4" />
          Privacy Testing
        </h3>
        <div className="flex flex-wrap gap-2 justify-center">
          <Button onClick={sendSensitiveNetworkRequest} variant="outline" size="sm">
            Sensitive Network Request
          </Button>
          <Button onClick={logSensitiveData} variant="outline" size="sm">
            Log Sensitive Data
          </Button>
          <Button onClick={captureSensitiveError} variant="outline" size="sm">
            Capture Sensitive Error
          </Button>
          <Button onClick={addSensitiveUrlParam} variant="outline" size="sm">
            Add Sensitive URL Param
          </Button>
          <Button onClick={flushEvents} variant="secondary" size="sm">
            Flush Events
          </Button>
        </div>
        <input
          id="credit-card"
          className="gc-mask px-2 py-1 text-sm border rounded"
          placeholder="card number"
          aria-label="card number"
        />
        {/* Plain input NOT matched by built-in sensitive patterns — used to
            test custom `privacy.sensitiveKeys` / `maskSelectors` matching. */}
        <input
          id="acct"
          className="px-2 py-1 text-sm border rounded"
          placeholder="account number"
          aria-label="account number"
        />
        {/* Inputs whose own id/name/placeholder are NOT sensitive — sensitivity
            comes ONLY from an ANCESTOR (a data-private wrapper, and a .gc-mask
            maskSelector wrapper). Exercises ancestor propagation. */}
        <div data-private>
          <input
            id="nested-private"
            className="px-2 py-1 text-sm border rounded"
            placeholder="nested under data-private"
            aria-label="nested under data-private"
          />
        </div>
        <div className="gc-mask">
          <input
            id="nested-mask"
            className="px-2 py-1 text-sm border rounded"
            placeholder="nested under mask selector"
            aria-label="nested under mask selector"
          />
        </div>
        {/* Plain static (non-input) text — visible under mask-sensitive,
            masked as `*` only under mask-all. */}
        <button id="static-label" className="text-sm border rounded px-2 py-1">
          VisibleStaticText
        </button>
      </div>
      
      <Button onClick={() => console.log("Debug log")} variant="outline">
        <Terminal className="mr-2" />
        Console Log
      </Button>

      <Button onClick={testConsoleError} variant="outline">
        <Bug className="mr-2" />
        Test Console Errors
      </Button>

      <Button onClick={testRequestPipeThrough} variant="outline">
        <GlobeLock className="mr-2" />
        Test Request.pipeThrough
      </Button>

      <div className="flex gap-2">
        <Button onClick={testCustomHeadersFetch} variant="outline">
          <Globe className="mr-2" />
          Test Custom Headers (Fetch)
        </Button>
        <Button onClick={testCustomHeadersXHR} variant="outline">
          <Globe className="mr-2" />
          Test Custom Headers (XHR)
        </Button>
      </div>

      <Button onClick={identifyUser} variant="outline">
        <User className="mr-2" />
        Identify User
      </Button>

      <Button onClick={simulateError} variant="destructive">
        <Bug className="mr-2" />
        Throw Error
      </Button>

      <Dialog>
        <DialogTrigger asChild>
          <Button>
            <Globe className="mr-2" />
            Make Network Request
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Network Request</DialogTitle>
            <DialogDescription>
              Configure your network request parameters.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="url">URL</label>
              <input
                id="url"
                className="col-span-3 p-2 border rounded"
                value={networkRequest.url}
                onChange={(e) =>
                  setNetworkRequest((prev) => ({
                    ...prev,
                    url: e.target.value,
                  }))
                }
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="method">Method</label>
              <select
                id="method"
                className="col-span-3 p-2 border rounded"
                value={networkRequest.method}
                onChange={(e) =>
                  setNetworkRequest((prev) => ({
                    ...prev,
                    method: e.target.value,
                  }))
                }
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="method">Type</label>
              <select
                id="type"
                className="col-span-3 p-2 border rounded"
                value={networkRequest.type}
                onChange={(e) =>
                  setNetworkRequest((prev) => ({
                    ...prev,
                    type: e.target.value,
                  }))
                }
              >
                <option value="fetch">Fetch</option>
                <option value="xhr">XHR</option>
                <option value="axios">Axios</option>
              </select>
            </div>
            {networkRequest.method !== "GET" && (
              <div className="grid grid-cols-4 items-center gap-4">
                <label htmlFor="body">Body</label>
                <textarea
                  id="body"
                  className="col-span-3 p-2 border rounded"
                  value={networkRequest.body}
                  onChange={(e) =>
                    setNetworkRequest((prev) => ({
                      ...prev,
                      body: e.target.value,
                    }))
                  }
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={handleNetworkRequest}>Send Request</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button onClick={trackCustomEvent} variant="secondary">
        <LineChart className="mr-2" />
        Send Custom Event
      </Button>

      <Button onClick={emitLoggerWarn} variant="secondary">
        <MessageSquare className="mr-2" />
        Logger.warn w/ Attributes
      </Button>

      <Button onClick={logWithStructuredObject} variant="secondary">
        <Layers className="mr-2" />
        Console.log w/ Structured Object
      </Button>

      <Button onClick={changeURLParams} variant="secondary">
        <GlobeLock className="mr-2" />
        Change URL Params
      </Button>

      <Button onClick={() => navigate("/other-page")} variant="outline">
        <AlertCircle className="mr-2" />
        Navigate
      </Button>

      <Button onClick={updateConfig} variant="outline">
        <AlertCircle className="mr-2" />
        Update Config
      </Button>

      {/* Manual Navigation Testing */}
      <div className="flex flex-col items-center gap-2 p-4 border rounded-lg bg-slate-50">
        <h3 className="font-semibold flex items-center gap-2">
          <Navigation className="w-4 h-4" />
          Manual Navigation Testing
        </h3>
        <div className="text-sm text-gray-600 mb-2">
          {navigationState.isActive ? (
            <span className="text-green-600 font-medium">
              ✅ Navigation Active (Started {navigationState.startTime ? 
                Math.floor((currentTime - navigationState.startTime) / 1000) : 0}s ago)
            </span>
          ) : (
            <span className="text-gray-500">⭕ No Active Navigation</span>
          )}
        </div>
        <div className="flex gap-2">
          <Button 
            onClick={startManualNavigation}
            disabled={navigationState.isActive}
            variant="default"
            size="sm"
          >
            <Play className="mr-2 w-4 h-4" />
            Start Navigation
          </Button>
          <Button 
            onClick={endManualNavigation}
            disabled={!navigationState.isActive}
            variant="destructive"
            size="sm"
          >
            <Square className="mr-2 w-4 h-4" />
            End Navigation
          </Button>
        </div>
        <p className="text-xs text-gray-500 max-w-md text-center">
          Check browser console and network tab to see navigation events. 
          The SDK ignores these calls while "navigation" is in enabledEvents, as it is on this page.
        </p>
      </div>

      {/* Session ID Testing */}
      <div className="flex flex-col items-center gap-2 p-4 border rounded-lg bg-blue-50">
        <h3 className="font-semibold flex items-center gap-2">
          <Hash className="w-4 h-4" />
          Session ID Testing
        </h3>
        <div className="text-sm text-gray-600 mb-2">
          Test setSessionId with automatic generation or custom values
        </div>
        
        {/* Session Actions */}
        <div className="flex gap-2 mb-3">
          <Button 
            onClick={generateNewSessionId}
            variant="default"
            size="sm"
          >
            <RefreshCw className="mr-2 w-4 h-4" />
            Generate New Session ID
          </Button>
          
          <div className="flex gap-1">
            <input
              type="text"
              placeholder="Enter custom session ID"
              className="px-2 py-1 text-sm border rounded"
              value={customSessionId}
              onChange={(e) => setCustomSessionId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setCustomSession()}
            />
            <Button 
              onClick={setCustomSession}
              variant="secondary"
              size="sm"
              disabled={!customSessionId.trim()}
            >
              Set Custom
            </Button>
          </div>
        </div>

        {/* Session History */}
        {sessionIdHistory.length > 0 && (
          <div className="w-full max-w-md">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-medium text-gray-700">Session Changes:</span>
              <Button 
                onClick={clearSessionHistory}
                variant="outline"
                size="sm"
                className="text-xs px-2 py-1 h-6"
              >
                Clear
              </Button>
            </div>
            <div className="bg-white border rounded p-2 text-xs space-y-1 max-h-24 overflow-y-auto">
              {sessionIdHistory.map((entry, index) => (
                <div key={index} className="text-gray-600">
                  {new Date().toLocaleTimeString()}: {entry}
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-xs text-gray-500 max-w-md text-center">
          Check browser console and network tab to see events flushed before session change. 
          Each session change will flush pending events first.
        </p>
      </div>

      {/* Release ID Testing */}
      <div className="flex flex-col items-center gap-2 p-4 border rounded-lg bg-purple-50">
        <h3 className="font-semibold flex items-center gap-2">
          <Tag className="w-4 h-4" />
          Release ID Testing
        </h3>
        <div className="text-sm text-gray-600 mb-2">
          Current release ID: <span className="font-mono bg-purple-100 px-2 py-0.5 rounded">v1.0.0-playground</span>
        </div>
        <Button 
          onClick={() => {
            groundcover.sendCustomEvent({
              event: 'release_id_test',
              attributes: {
                test_type: 'verify_release_id',
                expected_release_id: 'v1.0.0-playground',
                timestamp: Date.now()
              }
            })
            console.log('📦 Sent custom event to verify releaseId in session attributes')
            console.log('🔍 Check network tab - the batch should include releaseId: "v1.0.0-playground" in sessionAttributes')
          }}
          variant="default"
          size="sm"
        >
          <Tag className="mr-2 w-4 h-4" />
          Test Release ID
        </Button>
        <p className="text-xs text-gray-500 max-w-md text-center">
          Click to send a custom event and verify that releaseId is included in the session attributes. 
          Check the network tab to see the releaseId in the request payload.
        </p>
      </div>

      {/* Session Replay Testing */}
      <div className="flex flex-col items-center gap-2 p-4 border rounded-lg bg-green-50">
        <h3 className="font-semibold flex items-center gap-2">
          <Video className="w-4 h-4" />
          Session Replay Testing
        </h3>
        <div className="text-sm text-gray-600 mb-2">
          Test session replay (rrweb)
        </div>
        
        <div className="text-sm text-gray-600 mb-2">
          {isRecording ? (
            <span className="text-green-600 font-medium">
              🎥 Recording Active (Started {recordingStartTime ? 
                Math.floor((currentTime - recordingStartTime) / 1000) : 0}s ago)
            </span>
          ) : (
            <span className="text-gray-500">⭕ No Active Recording</span>
          )}
        </div>
        
        <div className="flex gap-2">
          <Button 
            onClick={startSessionReplay}
            disabled={isRecording}
            variant="default"
            size="sm"
          >
            <Video className="mr-2 w-4 h-4" />
            Start Recording
          </Button>
          <Button 
            onClick={stopSessionReplay}
            disabled={!isRecording}
            variant="destructive"
            size="sm"
          >
            <VideoOff className="mr-2 w-4 h-4" />
            Stop Recording
          </Button>
        </div>
        
        <p className="text-xs text-gray-500 max-w-md text-center">
          Start recording to capture DOM events, then stop to send the replay data.
          Check the network tab for replay events with type: "replay".
        </p>
      </div>

      {/* Canvas Chart — chart series drawn to a <canvas> (2D). Only captured in
          session replay when options.replay.canvas.enabled is set. */}
      <div className="flex flex-col items-center gap-2 p-4 border rounded-lg bg-amber-50">
        <h3 className="font-semibold flex items-center gap-2">
          <LineChart className="w-4 h-4" />
          Canvas Chart
        </h3>
        <div className="text-sm text-gray-600 mb-2 max-w-md text-center">
          Series are drawn to a <code>&lt;canvas&gt;</code>. rrweb only captures this in
          replay when canvas recording is enabled via <code>options.replay.canvas</code>.
        </div>
        <canvas
          id="replay-canvas"
          ref={canvasRef}
          width={480}
          height={200}
          className="border rounded bg-white"
          aria-label="canvas chart"
        />
        <Button onClick={drawChart} variant="default" size="sm">
          <LineChart className="mr-2 w-4 h-4" />
          Draw Chart
        </Button>
      </div>

      <Dialog>
        <DialogTrigger asChild>
          <Button variant="secondary">
            <MousePointer className="mr-2" />
            Simulate DOM Event
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>DOM Event Simulator</DialogTitle>
            <DialogDescription>
              Choose a DOM event to simulate.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Button onClick={() => simulateDOMEvent("click")} variant="outline">
              Click Event
            </Button>
            <Button
              onClick={() => simulateDOMEvent("mouseover")}
              variant="outline"
            >
              Mouseover Event
            </Button>
            <Button
              onClick={() => simulateDOMEvent("keydown")}
              variant="outline"
            >
              Keydown Event
            </Button>
            <Button onClick={() => simulateDOMEvent("focus")} variant="outline">
              Focus Event
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default App
