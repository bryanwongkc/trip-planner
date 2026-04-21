export async function fetchLatestJpyHkdRate() {
  const response = await fetch('https://api.frankfurter.app/latest?from=JPY&to=HKD')

  if (!response.ok) {
    throw new Error('Unable to fetch JPY/HKD rate')
  }

  const payload = await response.json()

  return {
    date: payload.date,
    rate: payload.rates.HKD,
  }
}
