const CHIBA_TOKYO_CORRIDOR = {
  lat: 35.6074,
  lng: 140.1065,
}

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

export async function fetchWeatherSnapshot() {
  const forecastDays = 16
  const params = new URLSearchParams({
    latitude: String(CHIBA_TOKYO_CORRIDOR.lat),
    longitude: String(CHIBA_TOKYO_CORRIDOR.lng),
    current: 'temperature_2m,weather_code',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'Asia/Tokyo',
    forecast_days: String(forecastDays),
  })

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`)

  if (!response.ok) {
    throw new Error('Unable to fetch weather snapshot')
  }

  const payload = await response.json()
  const dailyByDate = {}

  payload.daily.time.forEach((date, index) => {
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

  const currentWeatherKey = classifyWeatherCode(payload.current.weather_code)

  return {
    current: {
      temp: payload.current.temperature_2m,
      weatherKey: currentWeatherKey,
      label: WEATHER_LABELS[currentWeatherKey],
    },
    dailyByDate,
    availableDates: payload.daily.time,
    forecastDays,
  }
}
