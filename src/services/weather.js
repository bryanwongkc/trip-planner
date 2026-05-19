export const WEATHER_LABELS = {
  clear: 'Clear skies',
  cloudy: 'Cloud cover',
  fog: 'Foggy',
  rain: 'Rain showers',
  snow: 'Snow',
  thunder: 'Thunder risk',
}

function classifyWeatherCode(code) {
  if (code === 0) return 'clear'
  if ([1, 2, 3].includes(code)) return 'cloudy'
  if ([45, 48].includes(code)) return 'fog'
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow'
  if ([95, 96, 99].includes(code)) return 'thunder'
  return 'rain'
}

function mostCommon(values) {
  const counts = values.reduce((map, value) => {
    map.set(value, (map.get(value) || 0) + 1)
    return map
  }, new Map())

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || values[0]
}

function average(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (!valid.length) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function historicalDateForYear(date, year) {
  const [, month, day] = date.split('-')
  if (month === '02' && day === '29') return `${year}-02-28`
  return `${year}-${month}-${day}`
}

async function fetchHistoricalWeatherReference({ lat, lng, date, locationLabel }) {
  if (!date) return null

  const target = new Date(`${date}T12:00:00`)
  if (Number.isNaN(target.getTime())) return null

  const currentYear = new Date().getFullYear()
  const targetYear = target.getFullYear()
  const endYear = Math.min(targetYear - 1, currentYear - 1)
  if (endYear < 1940) return null

  const startYear = Math.max(1940, endYear - 9)
  const startDate = historicalDateForYear(date, startYear)
  const endDate = historicalDateForYear(date, endYear)
  const targetMonthDay = date.slice(5)

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
    timezone: 'auto',
    start_date: startDate,
    end_date: endDate,
  })

  const response = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params.toString()}`)

  if (!response.ok) return null

  const payload = await response.json()
  const indices =
    payload.daily?.time
      ?.map((historicalDate, index) => ({ historicalDate, index }))
      .filter(({ historicalDate }) => historicalDate.slice(5) === targetMonthDay) || []

  if (!indices.length) return null

  const weatherKeys = indices.map(({ index }) => classifyWeatherCode(payload.daily.weather_code[index]))
  const precipitationValues = indices.map(({ index }) => payload.daily.precipitation_sum[index])
  const rainDays = precipitationValues.filter((value) => typeof value === 'number' && value > 0.2).length
  const weatherKey = mostCommon(weatherKeys)

  return {
    date,
    historical: true,
    sampleYears: indices.length,
    locationLabel: locationLabel || '',
    weatherKey,
    label: WEATHER_LABELS[weatherKey],
    tempMax: average(indices.map(({ index }) => payload.daily.temperature_2m_max[index])),
    tempMin: average(indices.map(({ index }) => payload.daily.temperature_2m_min[index])),
    rainProbability: Math.round((rainDays / indices.length) * 100),
  }
}

export async function fetchWeatherSnapshot({ lat, lng, date, label } = {}) {
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return {
      current: null,
      dailyByDate: {},
      historicalByDate: {},
      availableDates: [],
      forecastDays: 0,
    }
  }

  const forecastDays = 16
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    current: 'temperature_2m,weather_code',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: String(forecastDays),
  })

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`)

  if (!response.ok) {
    throw new Error('Unable to fetch weather snapshot')
  }

  const payload = await response.json()
  const dailyByDate = {}

  payload.daily?.time?.forEach((date, index) => {
    const weatherKey = classifyWeatherCode(payload.daily.weather_code[index])
    dailyByDate[date] = {
      date,
      weatherKey,
      label: WEATHER_LABELS[weatherKey],
      tempMax: payload.daily.temperature_2m_max[index],
      tempMin: payload.daily.temperature_2m_min[index],
      rainProbability: payload.daily.precipitation_probability_max[index],
    }
  })

  const currentWeatherKey =
    typeof payload.current?.weather_code === 'number'
      ? classifyWeatherCode(payload.current.weather_code)
      : null

  const historicalReference = dailyByDate[date]
    ? null
    : await fetchHistoricalWeatherReference({ lat, lng, date, locationLabel: label })

  return {
    current: currentWeatherKey
      ? {
          temp: payload.current.temperature_2m,
          weatherKey: currentWeatherKey,
          label: WEATHER_LABELS[currentWeatherKey],
        }
      : null,
    dailyByDate,
    historicalByDate: historicalReference ? { [historicalReference.date]: historicalReference } : {},
    availableDates: payload.daily?.time || [],
    forecastDays,
  }
}
