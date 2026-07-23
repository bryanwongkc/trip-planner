// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { buildUpstreamUrl, normalizeFlightQuery } from '../api/aerodatabox'
import {
  buildFlightCodeChangePatch,
  extractFlightNumber,
  getFlightCodeInputValue,
  inferFlightLookupFromItem,
  normalizeFlightStatusPayload,
  selectFlightRecord,
} from '../src/services/aerodatabox'

describe('AeroDataBox request validation', () => {
  it('accepts airline flight numbers and rejects bare numbers', () => {
    expect(extractFlightNumber('CX 101')).toBe('CX101')
    expect(extractFlightNumber('1234')).toBe('')
    expect(normalizeFlightQuery({ flightNumber: 'U2123', date: '2026-07-16' })).toMatchObject({
      flightNumber: 'U2123',
    })
    expect(normalizeFlightQuery({ flightNumber: '1234', date: '2026-07-16' })).toBeNull()
  })

  it('does not expose the subscription balance resource', () => {
    expect(buildUpstreamUrl({ resource: 'balance' })).toBeNull()
    expect(buildUpstreamUrl({ resource: 'flight-status', flightNumber: 'CX101' })).toContain(
      '/flights/number/CX101',
    )
  })

  it('allows an applied flight code to be cleared and replaced', () => {
    const appliedFlight = {
      category: 'Flight',
      flightCode: 'HX605',
      title: 'Flight NRT to HKG (HX605)',
      startTime: '15:15',
      endTime: '19:20',
      description: 'Seat 12A\n\nDeparture: NRT · Tokyo Narita\nArrival: HKG · Hong Kong',
      flightInfo: { lookupKey: '2|HX605|2026-07-29' },
      dayDate: '2026-07-29',
    }

    const cleared = { ...appliedFlight, ...buildFlightCodeChangePatch(appliedFlight, '') }
    expect(getFlightCodeInputValue(cleared)).toBe('')
    expect(inferFlightLookupFromItem(cleared)).toBeNull()
    expect(cleared).toMatchObject({
      title: 'Flight',
      startTime: '',
      endTime: '',
      description: 'Seat 12A',
      flightInfo: null,
    })

    const replacement = { ...cleared, ...buildFlightCodeChangePatch(cleared, 'cx 501') }
    expect(getFlightCodeInputValue(replacement)).toBe('CX501')
    expect(inferFlightLookupFromItem(replacement)).toEqual({
      flightNumber: 'CX501',
      date: '2026-07-29',
    })
  })

  it('still reads a flight code from legacy items without a flightCode field', () => {
    expect(
      inferFlightLookupFromItem({
        category: 'Flight',
        title: 'Flight NRT to HKG (HX605)',
        dayDate: '2026-07-29',
      }),
    ).toEqual({
      flightNumber: 'HX605',
      date: '2026-07-29',
    })
  })

  it('selects the complete, current schedule when a flight number has duplicate records', () => {
    const records = normalizeFlightStatusPayload([
      {
        number: 'HX 605',
        codeshareStatus: 'Unknown',
        lastUpdatedUtc: '2026-04-28 07:35Z',
        departure: {
          airport: { iata: 'NRT', name: 'Tokyo Narita' },
          scheduledTime: { local: '2026-07-29 14:50+09:00' },
          terminal: '2',
        },
        arrival: {
          airport: { name: 'Hong Kong' },
        },
        aircraft: { model: 'Airbus A350-900' },
      },
      {
        number: 'HX 605',
        codeshareStatus: 'IsOperator',
        lastUpdatedUtc: '2026-07-13 17:19Z',
        departure: {
          airport: { iata: 'NRT', name: 'Tokyo Narita' },
          scheduledTime: { local: '2026-07-29 15:15+09:00' },
          terminal: '1',
        },
        arrival: {
          airport: { iata: 'HKG', name: 'Hong Kong Chek Lap Kok' },
          scheduledTime: { local: '2026-07-29 19:20+08:00' },
          terminal: '1',
        },
        aircraft: { model: 'Airbus A320' },
      },
    ])

    expect(selectFlightRecord(records, 'HX605')).toMatchObject({
      departureAirport: 'NRT',
      arrivalAirport: 'HKG',
      scheduledDeparture: '2026-07-29 15:15+09:00',
      scheduledArrival: '2026-07-29 19:20+08:00',
      aircraftModel: 'Airbus A320',
    })
  })

  it('prefers the most recently updated time when duplicate records are equally complete', () => {
    const records = [
      {
        number: 'HX 605',
        departureAirport: 'NRT',
        arrivalAirport: 'HKG',
        scheduledDeparture: '2026-09-29 15:15+09:00',
        scheduledArrival: '2026-09-29 19:20+08:00',
        lastUpdatedUtc: '2026-04-28 07:35Z',
      },
      {
        number: 'HX 605',
        departureAirport: 'NRT',
        arrivalAirport: 'HKG',
        scheduledDeparture: '2026-09-29 14:50+09:00',
        scheduledArrival: '2026-09-29 18:55+08:00',
        lastUpdatedUtc: '2026-07-13 17:19Z',
      },
    ]

    expect(selectFlightRecord(records, 'HX605')).toMatchObject({
      scheduledDeparture: '2026-09-29 14:50+09:00',
      scheduledArrival: '2026-09-29 18:55+08:00',
    })
  })
})
