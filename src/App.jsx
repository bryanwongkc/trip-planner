import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plane,
  Car,
  Hotel,
  PartyPopper,
  ShoppingBag,
  MapPin,
  Plus,
  X,
  Map as MapIcon,
  Cloud,
  Loader2,
  Wallet,
  Sun,
  ArrowLeftRight,
  RefreshCw,
  CloudRain,
  Edit3,
  ExternalLink,
  Copy,
  Navigation2,
  Check,
} from 'lucide-react'
import { STATIC_ITINERARY, TRIP_DATES } from './data/seedItinerary'
import {
  ensureAnonymousAuth,
  firebaseEnabled,
  subscribeToOverrides,
  upsertItemOverride,
} from './services/firebase'
import { fetchLatestJpyHkdRate } from './services/currency'
import { fetchWeatherSnapshot } from './services/weather'

const SAVE_DEBOUNCE_MS = 1000
const DATES = ['All', ...TRIP_DATES]

const EXPENSES = [
  { id: 'hotel', label: 'Hotel Mikazuki', amountJPY: 48600 },
  { id: 'car', label: 'Rental car', amountJPY: 27800 },
  { id: 'shugi', label: 'Shugi-fukuro', amountJPY: 30000 },
]

function getDateKey(isoString) {
  return isoString.slice(0, 10)
}

function toTimeValue(isoString) {
  return isoString.slice(11, 16)
}

function withUpdatedTime(isoString, nextTime) {
  return `${isoString.slice(0, 10)}T${nextTime}:00+09:00`
}

function formatDate(dateStr) {
  const date = new Date(`${dateStr}T00:00:00+09:00`)
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function classifyType(category) {
  if (category === 'Transit') {
    return 'car'
  }
  if (category === 'Stay') {
    return 'hotel'
  }
  if (category === 'Wedding') {
    return 'wedding'
  }
  if (category === 'Shopping') {
    return 'activity'
  }
  return 'activity'
}

function mergeItinerary(overrides) {
  return STATIC_ITINERARY.map((item) => ({
    ...item,
    type: classifyType(item.category),
    time: toTimeValue(item.startISO),
    ...(overrides[item.id] || {}),
  })).sort((first, second) =>
    `${first.date ?? getDateKey(first.startISO)}T${first.time ?? toTimeValue(first.startISO)}`.localeCompare(
      `${second.date ?? getDateKey(second.startISO)}T${second.time ?? toTimeValue(second.startISO)}`,
    ),
  )
}

function weatherIcon(snapshot) {
  if (!snapshot) {
    return <Cloud className="text-slate-300" />
  }

  if (snapshot.rainProbability >= 40) {
    return <CloudRain className="text-indigo-400" />
  }

  if (snapshot.weatherKey === 'clear') {
    return <Sun className="text-yellow-400" />
  }

  return <Cloud className="text-blue-300" />
}

export default function App() {
  const [activeTab, setActiveTab] = useState('itinerary')
  const [activeDay, setActiveDay] = useState('All')
  const [userReady, setUserReady] = useState(false)
  const [overrides, setOverrides] = useState({})
  const [editingItem, setEditingItem] = useState(null)
  const [actionItem, setActionItem] = useState(null)
  const [autosaveStatus, setAutosaveStatus] = useState(firebaseEnabled ? 'saved' : 'local')
  const [rate, setRate] = useState(null)
  const [weatherState, setWeatherState] = useState({ loading: true, data: null, error: '' })

  const longPressTimer = useRef(null)
  const movedRef = useRef(false)
  const longPressedRef = useRef(false)
  const debounceTimer = useRef(null)
  const dirtyItemIdRef = useRef(null)

  const items = useMemo(() => mergeItinerary(overrides), [overrides])
  const filteredItems = items.filter((item) => activeDay === 'All' || item.date === activeDay)

  useEffect(() => {
    let unsub = () => {}

    async function bootstrap() {
      if (!firebaseEnabled) {
        setUserReady(true)
        return
      }

      try {
        await ensureAnonymousAuth()
        setUserReady(true)
        unsub = subscribeToOverrides((payload) => {
          setOverrides(payload?.items || {})
        }, console.error)
      } catch (error) {
        console.error(error)
        setUserReady(true)
      }
    }

    bootstrap()
    return () => unsub()
  }, [])

  useEffect(() => {
    let cancelled = false

    fetchLatestJpyHkdRate()
      .then((data) => {
        if (!cancelled) {
          setRate(data.rate)
        }
      })
      .catch(console.error)

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    fetchWeatherSnapshot()
      .then((data) => {
        if (!cancelled) {
          setWeatherState({ loading: false, data, error: '' })
        }
      })
      .catch((error) => {
        console.error(error)
        if (!cancelled) {
          setWeatherState({ loading: false, data: null, error: 'Weather unavailable' })
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!editingItem) {
      return
    }

    if (!firebaseEnabled || !userReady) {
      return
    }

    dirtyItemIdRef.current = editingItem.id

    if (debounceTimer.current) {
      window.clearTimeout(debounceTimer.current)
    }

    debounceTimer.current = window.setTimeout(async () => {
      try {
        await upsertItemOverride(editingItem.id, {
          title: editingItem.title,
          description: editingItem.description,
          startISO: withUpdatedTime(editingItem.startISO, editingItem.time),
          time: editingItem.time,
        })
        setAutosaveStatus('saved')
      } catch (error) {
        console.error(error)
        setAutosaveStatus('error')
      }
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (debounceTimer.current) {
        window.clearTimeout(debounceTimer.current)
      }
    }
  }, [editingItem, userReady])

  const activeWeather =
    activeDay !== 'All' ? weatherState.data?.dailyByDate?.[activeDay] ?? null : null

  function updateEditingItem(changes) {
    setAutosaveStatus(firebaseEnabled && userReady ? 'saving' : 'local')
    setEditingItem((current) => (current ? { ...current, ...changes } : current))
    setOverrides((current) => ({
      ...current,
      [dirtyItemIdRef.current || editingItem?.id]: {
        ...(current[dirtyItemIdRef.current || editingItem?.id] || {}),
        ...changes,
      },
    }))
  }

  function handleStartPress(item) {
    movedRef.current = false
    longPressedRef.current = false
    longPressTimer.current = window.setTimeout(() => {
      if (!movedRef.current) {
        longPressedRef.current = true
        navigator.vibrate?.(50)
        setActionItem(item)
      }
    }, 600)
  }

  function handleMovePress() {
    movedRef.current = true
  }

  function handleEndPress(item) {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }

    if (!movedRef.current && !longPressedRef.current) {
      setAutosaveStatus(firebaseEnabled && userReady ? 'saved' : 'local')
      setEditingItem({
        ...item,
        time: item.time || toTimeValue(item.startISO),
        date: item.date || getDateKey(item.startISO),
      })
    }
  }

  function handleCloseEditor() {
    setEditingItem(null)
    setAutosaveStatus(firebaseEnabled ? 'saved' : 'local')
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-50 font-sans text-slate-900">
      <header className="shrink-0 border-b border-slate-100 bg-white px-6 pb-4 pt-10">
        <div className="flex items-end justify-between">
          <div>
            <p className="mb-1 text-[10px] font-black uppercase tracking-[0.2em] text-indigo-600">
              Chiba Family Trip
            </p>
            <h1 className="text-2xl font-black tracking-tighter text-slate-900">MAY 09 — 13</h1>
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50 p-2">
            <Cloud className={`h-4 w-4 ${firebaseEnabled ? 'text-emerald-500' : 'text-slate-300'}`} />
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
              {firebaseEnabled ? 'Cloud Synced' : 'Ready'}
            </span>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        {activeTab === 'itinerary' ? (
          <div className="flex h-full flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-4 py-6">
              <div className="space-y-6">
                <div className="flex items-center justify-between rounded-3xl border border-slate-100 bg-white p-6 shadow-sm">
                  <div>
                    <h2 className="text-2xl font-black tracking-tight text-slate-900">
                      {activeDay === 'All' ? 'Schedule' : formatDate(activeDay)}
                    </h2>
                    <p className="mt-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                      <Navigation2 className="h-3 w-3 text-indigo-500" />
                      Hold for map • Tap to edit
                    </p>
                  </div>
                  {activeDay !== 'All' && (
                    <div className="flex flex-col items-end">
                      <div className="flex items-center gap-2">
                        <span className="text-2xl font-black text-slate-800">
                          {activeWeather ? `${Math.round(activeWeather.tempMax)}°` : '--'}
                        </span>
                        {weatherIcon(activeWeather)}
                      </div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                        {activeWeather ? `${activeWeather.label} • rain ${activeWeather.rainProbability ?? 0}%` : weatherState.error || 'Loading'}
                      </p>
                    </div>
                  )}
                </div>

                <div className="no-scrollbar flex gap-2 overflow-x-auto pb-2">
                  {DATES.map((date) => (
                    <button
                      key={date}
                      onClick={() => setActiveDay(date)}
                      className={`whitespace-nowrap rounded-2xl px-5 py-2.5 text-[10px] font-black uppercase shadow-sm transition-all ${
                        activeDay === date
                          ? 'bg-indigo-600 text-white ring-4 ring-indigo-50'
                          : 'bg-white text-slate-400'
                      }`}
                    >
                      {date === 'All' ? 'Overview' : date.split('-').slice(1).join('/')}
                    </button>
                  ))}
                </div>

                <div className="space-y-3">
                  {filteredItems.map((item) => (
                    <div key={item.id} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div
                        onMouseDown={() => handleStartPress(item)}
                        onMouseUp={() => handleEndPress(item)}
                        onMouseLeave={() => handleEndPress(item)}
                        onTouchStart={() => handleStartPress(item)}
                        onTouchEnd={() => handleEndPress(item)}
                        onTouchMove={handleMovePress}
                        onContextMenu={(event) => event.preventDefault()}
                        className="group relative flex cursor-pointer select-none items-start gap-4 rounded-3xl border border-slate-100 bg-white p-5 shadow-sm transition-colors active:bg-slate-50"
                      >
                        <div className={`rounded-2xl p-3 ${iconTone(item.type)}`}>
                          <TypeIcon type={item.type} className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-start justify-between">
                            <span className="text-[10px] font-black uppercase tracking-wider text-indigo-600">
                              {item.time}
                            </span>
                            <div className="flex gap-1 opacity-20 transition-opacity group-hover:opacity-100">
                              <MapIcon className="h-3 w-3 text-slate-400" />
                              <Edit3 className="h-3 w-3 text-slate-400" />
                            </div>
                          </div>
                          <h3 className="text-sm font-bold leading-tight text-slate-900">{item.title}</h3>
                          {item.description ? (
                            <p className="mt-2 rounded-xl bg-slate-50 p-2 px-3 text-[11px] italic text-slate-500">
                              {item.description}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <CostTool rate={rate} />
        )}
      </div>

      {actionItem ? (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg animate-in rounded-[2rem] bg-white p-4 duration-300 slide-in-from-bottom">
            <div className="mb-2 flex items-center gap-4 border-b border-slate-50 p-4">
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600">
                <MapPin className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Destination</p>
                <p className="truncate text-sm font-bold text-slate-900">{actionItem.title}</p>
              </div>
            </div>
            <div className="space-y-2">
              <button
                onClick={() => {
                  window.open(
                    `https://www.google.com/maps/search/?api=1&query=${actionItem.lat},${actionItem.lng}`,
                    '_blank',
                  )
                  setActionItem(null)
                }}
                className="flex w-full items-center justify-between rounded-2xl bg-indigo-600 p-4 text-sm font-bold text-white shadow-lg shadow-indigo-100"
              >
                Navigate in Google Maps
                <ExternalLink className="h-4 w-4" />
              </button>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(`${actionItem.lat}, ${actionItem.lng}`)
                  setActionItem(null)
                }}
                className="flex w-full items-center justify-between rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-900"
              >
                Copy GPS Coordinates
                <Copy className="h-4 w-4" />
              </button>
              <button
                onClick={() => setActionItem(null)}
                className="mt-2 w-full p-4 text-center text-xs font-black uppercase tracking-widest text-slate-400"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editingItem ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 backdrop-blur-md sm:items-center">
          <div className="w-full max-w-lg animate-in rounded-t-[2.5rem] bg-white p-8 duration-300 slide-in-from-bottom sm:rounded-[2.5rem]">
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-2xl bg-indigo-50 p-3 text-indigo-600">
                    <TypeIcon type={editingItem.type} className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-black uppercase leading-none tracking-tight text-slate-900">
                      {editingItem.title}
                    </h2>
                    <div className="mt-1 flex items-center gap-2">
                      {autosaveStatus === 'saving' ? (
                        <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-indigo-500 animate-pulse">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          Autosaving...
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-emerald-500">
                          <Check className="h-3 w-3" />
                          {autosaveStatus === 'local' ? 'Stored locally' : 'All changes synced'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <button onClick={handleCloseEditor} className="rounded-full bg-slate-100 p-2">
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-400">
                      Local Time
                    </label>
                    <input
                      type="time"
                      value={editingItem.time}
                      onChange={(event) =>
                        updateEditingItem({
                          time: event.target.value,
                          startISO: withUpdatedTime(editingItem.startISO, event.target.value),
                        })
                      }
                      className="w-full rounded-2xl border-2 border-transparent bg-slate-50 p-4 text-sm font-bold outline-none transition focus:border-indigo-600"
                    />
                  </div>
                  <div
                    onClick={() => {
                      setActionItem({ ...editingItem })
                      setEditingItem(null)
                    }}
                    className="cursor-pointer"
                  >
                    <label className="mb-1 block text-[10px] font-black uppercase tracking-widest text-indigo-400">
                      GPS Location
                    </label>
                    <div className="flex w-full items-center justify-between rounded-2xl bg-indigo-50 p-4 text-xs font-bold uppercase text-indigo-600">
                      View Options
                      <Navigation2 className="h-3 w-3" />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-400">
                    Title
                  </label>
                  <input
                    type="text"
                    value={editingItem.title}
                    onChange={(event) => updateEditingItem({ title: event.target.value })}
                    className="w-full rounded-2xl border-2 border-transparent bg-slate-50 p-4 text-sm font-bold outline-none transition focus:border-indigo-600"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-400">
                    Booking Refs / Toddler Notes
                  </label>
                  <textarea
                    rows="4"
                    value={editingItem.description || ''}
                    onChange={(event) => updateEditingItem({ description: event.target.value })}
                    className="w-full resize-none rounded-2xl border-2 border-transparent bg-slate-50 p-4 text-sm font-medium outline-none transition focus:border-indigo-600"
                    placeholder="Paste booking codes or diaper bag reminders..."
                  />
                </div>
              </div>

              <button
                onClick={handleCloseEditor}
                className="w-full rounded-[1.5rem] bg-slate-900 py-5 text-xs font-black uppercase tracking-[0.2em] text-white shadow-xl transition-all hover:bg-slate-800"
              >
                Done Planning
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <nav className="shrink-0 border-t border-slate-100 bg-white p-4 px-10 pb-10">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setActiveTab('itinerary')}
            className={`flex flex-col items-center gap-1.5 transition-all ${
              activeTab === 'itinerary' ? 'scale-110 text-indigo-600' : 'text-slate-300'
            }`}
          >
            <MapIcon className="h-6 w-6" />
            <span className="text-[9px] font-black uppercase">Itinerary</span>
          </button>

          <button className="rounded-3xl border-4 border-white bg-indigo-600 p-4 text-white shadow-2xl transition-transform active:scale-95 -mt-12">
            <Plus className="h-6 w-6" />
          </button>

          <button
            onClick={() => setActiveTab('cost')}
            className={`flex flex-col items-center gap-1.5 transition-all ${
              activeTab === 'cost' ? 'scale-110 text-indigo-600' : 'text-slate-300'
            }`}
          >
            <Wallet className="h-6 w-6" />
            <span className="text-[9px] font-black uppercase">Exchange</span>
          </button>
        </div>
      </nav>

      <style
        dangerouslySetInnerHTML={{
          __html: `
          .no-scrollbar::-webkit-scrollbar { display: none; }
          .animate-in { animation: slideUp 0.3s ease-out forwards; }
          @keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        `,
        }}
      />
    </div>
  )
}

function CostTool({ rate }) {
  const [jpy, setJpy] = useState('5000')
  const hkd = rate ? (Number(jpy || 0) * rate).toFixed(2) : '...'
  const totalHkd = rate
    ? EXPENSES.reduce((sum, expense) => sum + expense.amountJPY * rate, 0).toFixed(2)
    : '...'

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10 animate-in duration-300 slide-in-from-bottom">
      <div className="space-y-8">
        <div className="relative overflow-hidden rounded-[3rem] bg-slate-900 p-10 text-center text-white shadow-2xl">
          <div className="relative z-10">
            <p className="mb-6 text-[10px] font-black uppercase tracking-[0.3em] text-indigo-400">
              Shopping Converter
            </p>
            <div className="flex flex-col items-center gap-6">
              <div className="flex items-center gap-4">
                <span className="text-4xl font-black text-slate-700">¥</span>
                <input
                  type="number"
                  value={jpy}
                  onChange={(event) => setJpy(event.target.value)}
                  className="w-48 border-b-2 border-slate-800 bg-transparent pb-2 text-center text-5xl font-black outline-none"
                />
              </div>
              <ArrowLeftRight className="h-6 w-6 text-indigo-500" />
              <div className="flex items-center gap-4">
                <span className="text-4xl font-black text-slate-700">$</span>
                <div className="text-5xl font-black">{hkd}</div>
              </div>
              <p className="mt-4 text-[10px] font-bold uppercase text-slate-500">
                Live Exchange: {rate ? rate.toFixed(4) : 'loading'}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {EXPENSES.map((expense) => (
            <div
              key={expense.id}
              className="flex items-center justify-between rounded-3xl border border-slate-100 bg-white p-5 shadow-sm"
            >
              <div>
                <p className="text-sm font-bold text-slate-900">{expense.label}</p>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                  ¥{expense.amountJPY.toLocaleString()}
                </p>
              </div>
              <p className="text-lg font-black text-indigo-600">
                {rate ? `$${(expense.amountJPY * rate).toFixed(2)}` : '...'}
              </p>
            </div>
          ))}
          <div className="rounded-3xl bg-indigo-600 p-5 text-white shadow-lg shadow-indigo-100">
            <p className="text-[10px] font-black uppercase tracking-widest text-indigo-100">Trip total</p>
            <p className="mt-1 text-2xl font-black">${totalHkd}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function TypeIcon({ type, className }) {
  switch (type) {
    case 'flight':
      return <Plane className={className} />
    case 'car':
      return <Car className={className} />
    case 'hotel':
      return <Hotel className={className} />
    case 'wedding':
      return <PartyPopper className={className} />
    case 'activity':
      return <ShoppingBag className={className} />
    default:
      return <MapPin className={className} />
  }
}

function iconTone(type) {
  if (type === 'wedding') {
    return 'bg-pink-50 text-pink-500'
  }

  if (type === 'hotel') {
    return 'bg-amber-50 text-amber-500'
  }

  return 'bg-indigo-50 text-indigo-500'
}
