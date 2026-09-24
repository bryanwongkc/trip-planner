#!/usr/bin/env node

// A small, local-only GitHub queue claim. Requires an authenticated GitHub CLI.
import { execFileSync } from 'node:child_process'

const repo = 'bryanwongkc/trip-planner'
const command = process.argv[2] || 'next'
const requiredSections = [
  'Type',
  'Affected screen/component',
  'Problem and evidence',
  'Expected behavior',
  'Acceptance criteria',
  'Severity/frequency',
  'Constraints and out of scope',
  'Privacy/data implications',
  'Source feedback',
]

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function api(path, options = []) {
  return JSON.parse(gh(['api', ...options, path]))
}

function findIssues(labels) {
  const output = gh([
    'api', '--paginate', '--jq', '.[] | {number, title, body, created_at, labels, pull_request}',
    `repos/${repo}/issues?state=open&labels=${labels.map(encodeURIComponent).join(',')}&per_page=100`,
  ])
  return output.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((issue) => !issue.pull_request)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number)
}

function labelNames(issue) {
  return new Set(issue.labels.map((label) => label.name))
}

function exists(path) {
  try {
    api(path)
    return true
  } catch (error) {
    const stderr = String(error.stderr || '')
    if (/HTTP 404|Not Found/i.test(stderr)) return false
    throw error
  }
}

function checkSpec(issue) {
  const body = issue.body || ''
  const missing = requiredSections.filter((name) =>
    !new RegExp(`^#{2,3} ${name.replace('/', '\\/')}\\s*$`, 'im').test(body))
  if (missing.length) {
    throw new Error(`Proposal #${issue.number} needs sections: ${missing.join(', ')}. Edit it before claiming.`)
  }
  const sourceLinks = [...body.matchAll(new RegExp(`https://github\\.com/${repo.replace('/', '\\/')}/issues/(\\d+)`, 'g'))]
  if (!sourceLinks.some((match) => Number(match[1]) !== issue.number)) {
    throw new Error(`Proposal #${issue.number} needs a source feedback issue link.`)
  }
  if (/^\*\*No product change yet\b/im.test(body)) {
    throw new Error(`Proposal #${issue.number} recommends no product change. Approve a concrete scope first.`)
  }
}

function existingPr(number) {
  const results = JSON.parse(gh([
    'pr', 'list', '--repo', repo, '--state', 'all', '--head', `codex/feedback-${number}`,
    '--limit', '100', '--json', 'number,state,url',
  ]))
  return results[0]
}

function selectNext() {
  const issues = findIssues(['feedback-proposal', 'approved-for-build'])
  const queued = issues.filter((issue) => {
    const labels = labelNames(issue)
    return !labels.has('codex-in-progress') && !labels.has('codex-pr-open')
  })
  if (!queued.length) return null
  const issue = queued[0]
  const branch = `codex/feedback-${issue.number}`
  checkSpec(issue)
  if (existingPr(issue.number) || exists(`repos/${repo}/branches/${branch}`)) {
    throw new Error(`Proposal #${issue.number} already has a PR or branch. Reconcile its labels before taking another item.`)
  }
  return { issue, branch }
}

try {
  if (!['next', 'claim'].includes(command)) throw new Error('Usage: node scripts/feedback-queue.mjs [next|claim]')
  gh(['auth', 'status'])
  const active = findIssues(['feedback-proposal', 'codex-in-progress'])
  if (active.length) {
    throw new Error(`Proposal #${active[0].number} is already in progress. Resume or resolve it first.`)
  }
  const selected = selectNext()
  if (!selected) {
    console.log('No approved feedback proposal is ready.')
    process.exit(0)
  }
  const { issue, branch } = selected
  if (command === 'next') {
    console.log(`Next: ${issue.html_url || `https://github.com/${repo}/issues/${issue.number}`} (${issue.title})`)
    console.log(`Claim with: node scripts/feedback-queue.mjs claim`)
  } else {
    // Recheck the issue directly. The ref creation is the per-proposal atomic claim;
    // GitHub rejects it if another worker created the same ref first.
    const latest = api(`repos/${repo}/issues/${issue.number}`)
    const labels = labelNames(latest)
    if (latest.state !== 'open' || !labels.has('approved-for-build') || !labels.has('feedback-proposal') ||
        labels.has('codex-in-progress') || labels.has('codex-pr-open')) {
      throw new Error(`Proposal #${issue.number} changed before claim. Run again.`)
    }
    checkSpec(latest)
    const main = api(`repos/${repo}/branches/main`)
    api(`repos/${repo}/git/refs`, [
      '-X', 'POST', '-f', `ref=refs/heads/${branch}`, '-f', `sha=${main.commit.sha}`,
    ])
    try {
      api(`repos/${repo}/issues/${issue.number}/labels`, ['-X', 'POST', '-f', 'labels[]=codex-in-progress'])
    } catch (error) {
      throw new Error(`Created ${branch}, but could not add codex-in-progress to #${issue.number}. Reconcile the branch and label; do not claim again. ${error.message}`)
    }
    console.log(`Claimed #${issue.number}: https://github.com/${repo}/issues/${issue.number}`)
    console.log(`Branch: ${branch}`)
    console.log(`Run: git fetch origin ${branch} && git switch --track origin/${branch}`)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
