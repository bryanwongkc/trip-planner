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

export async function fetchWeatherSnapshot({ lat, lng } = {}) {
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return {
      current: null,
      dailyByDate: {},
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

  return {
    current: currentWeatherKey
      ? {
          temp: payload.current.temperature_2m,
          weatherKey: currentWeatherKey,
          label: WEATHER_LABELS[currentWeatherKey],
        }
      : null,
    dailyByDate,
    availableDates: payload.daily?.time || [],
    forecastDays,
  }
}
