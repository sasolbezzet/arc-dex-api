const PRIORITY_KEYS = [
  'name', 'label', 'entityName', 'entityType', 'address', 'hash', 'txHash', 'chain', 'blockchain',
  'symbol', 'tokenName', 'balance', 'usdValue', 'price', 'volume', 'amount', 'status', 'timestamp',
]

export function buildIntelPresentation(payload, context = {}) {
  const root = unwrap(payload)
  const rootFields = scalarFields(root, '', 16, 2)
  const sections = buildSections(root)
  const recordCount = sections.reduce((total, section) => total + section.records.length, 0)
  const fieldCount = rootFields.length + sections.reduce((total, section) => (
    total + section.fields.length + section.records.reduce((sum, record) => sum + record.fields.length, 0)
  ), 0)
  const title = preferredValue(root, ['name', 'label', 'entityName', 'symbol', 'address', 'hash', 'txHash', 'id'])
  const subtitle = preferredValue(root, ['description', 'summary', 'entityType', 'type', 'chain', 'blockchain'])
  const errors = Array.isArray(payload?.errors) ? payload.errors.map(error => ({
    section: String(error?.section || 'unknown'),
    message: String(error?.message || error || 'Unknown error'),
  })) : []

  return {
    version: 1,
    title: title || context.serviceLabel || 'ARCOX Intel Result',
    subtitle: subtitle || 'Structured on-chain intelligence returned by Arkham through ARCOX.',
    service: context.service || context.serviceLabel || 'arcox_intel',
    resource: context.resource || '',
    providerPath: context.providerPath || '',
    provider: 'Arkham Intel API',
    generatedAt: new Date().toISOString(),
    query: cleanQuery(context.query),
    overview: prioritizeFields(rootFields).slice(0, 12),
    sections,
    dataQuality: {
      status: errors.length ? 'partial' : fieldCount || recordCount ? 'complete' : 'empty',
      fieldCount,
      recordCount,
      sectionCount: sections.length,
      partial: errors.length > 0,
      errors,
    },
    guidance: [
      'Values are reported from Arkham and may change as labels and on-chain data evolve.',
      'Attribution can be probabilistic; verify critical decisions against primary chain data.',
      'Informational only. Not financial advice.',
    ],
  }
}

function buildSections(root) {
  if (Array.isArray(root)) return [arraySection('Records', root, 'records')]
  if (!isObject(root)) return []

  const sections = []
  for (const [key, value] of Object.entries(root)) {
    if (['ok', 'mode', 'cached', 'disclaimer', 'errors', 'x402Payment', 'intelPresentation'].includes(key)) continue
    const unwrapped = unwrap(value)
    if (key === 'report' && isObject(unwrapped)) {
      for (const [reportKey, reportValue] of Object.entries(unwrapped)) {
        const reportRoot = unwrap(reportValue)
        if (!isObject(reportRoot) && !Array.isArray(reportRoot)) continue
        if (Array.isArray(reportRoot)) {
          sections.push(arraySection(humanize(reportKey), reportRoot, `report.${reportKey}`))
          continue
        }
        const fields = prioritizeFields(scalarFields(reportRoot, `report.${reportKey}`, 24)).slice(0, 20)
        const records = nestedRecords(reportRoot, `report.${reportKey}`)
        sections.push({
          id: slug(`report-${reportKey}`),
          title: humanize(reportKey),
          description: sectionDescription(fields.length, records.length),
          fields,
          records,
        })
      }
      continue
    }
    if (Array.isArray(unwrapped)) {
      sections.push(arraySection(humanize(key), unwrapped, key))
      continue
    }
    if (isObject(unwrapped)) {
      const fields = prioritizeFields(scalarFields(unwrapped, key, 20)).slice(0, 16)
      const records = nestedRecords(unwrapped, key)
      sections.push({
        id: slug(key),
        title: humanize(key),
        description: sectionDescription(fields.length, records.length),
        fields,
        records,
      })
    }
  }
  return sections.filter(section => section.fields.length || section.records.length).slice(0, 16)
}

function nestedRecords(value, parentPath) {
  const records = []
  for (const [key, child] of Object.entries(value)) {
    const unwrapped = unwrap(child)
    if (Array.isArray(unwrapped)) {
      records.push(...recordsFromArray(unwrapped, `${parentPath}.${key}`, humanize(key)))
    }
  }
  return records.slice(0, 30)
}

function arraySection(title, items, path) {
  const records = recordsFromArray(items, path, title)
  return {
    id: slug(path),
    title,
    description: `${items.length} record${items.length === 1 ? '' : 's'} returned`,
    fields: [],
    records,
  }
}

function recordsFromArray(items, path, fallbackTitle) {
  return items.slice(0, 30).map((item, index) => {
    if (!isObject(item)) {
      return {
        index: index + 1,
        title: `${fallbackTitle} ${index + 1}`,
        fields: [field('Value', item, `${path}.${index}`)],
      }
    }
    const fields = prioritizeFields(scalarFields(item, `${path}.${index}`, 16)).slice(0, 12)
    return {
      index: index + 1,
      title: preferredValue(item, ['name', 'label', 'entityName', 'tokenName', 'symbol', 'token.symbol', 'token.name', 'arkhamLabel.name', 'address', 'hash', 'txHash', 'id']) || `${fallbackTitle} ${index + 1}`,
      fields,
    }
  })
}

function scalarFields(value, parentPath, limit, depth = 0, labelPrefix = '') {
  if (!isObject(value)) return []
  const fields = []
  for (const [key, child] of Object.entries(value)) {
    if (fields.length >= limit) break
    if (child === undefined || child === null || child === '') continue
    const path = parentPath ? `${parentPath}.${key}` : key
    const label = `${labelPrefix}${humanize(key)}`
    if (isScalar(child)) {
      fields.push(field(label, child, path, key))
    } else if (isObject(child) && depth < 2) {
      fields.push(...scalarFields(child, path, limit - fields.length, depth + 1, `${label} `))
    }
  }
  return fields
}

function field(label, rawValue, path, key = path.split('.').at(-1) || '') {
  return {
    label,
    value: displayValue(rawValue, key),
    rawValue: typeof rawValue === 'bigint' ? rawValue.toString() : rawValue,
    path,
    kind: valueKind(rawValue, key),
  }
}

function displayValue(value, key) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  const text = String(value)
  if (isTimestamp(value, key)) {
    const date = new Date(normalizeTimestamp(value))
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  if (isNumeric(value)) {
    const number = Number(value)
    if (Number.isFinite(number)) {
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(number)
    }
  }
  return text
}

function valueKind(value, key) {
  const text = String(value)
  if (/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(text)) return 'address'
  if (/^(0x[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{64,100})$/.test(text)) return 'hash'
  if (isTimestamp(value, key)) return 'datetime'
  if (typeof value === 'boolean') return 'boolean'
  if (isNumeric(value)) return /usd|price|value|volume|balance|amount|inflow|outflow/i.test(key) ? 'amount' : 'number'
  if (/url|link|website|explorer/i.test(key) && /^https?:\/\//.test(text)) return 'url'
  return 'text'
}

function prioritizeFields(fields) {
  return [...fields].sort((left, right) => priority(left.path) - priority(right.path))
}

function priority(path) {
  const key = path.split('.').at(-1) || ''
  const index = PRIORITY_KEYS.findIndex(candidate => candidate.toLowerCase() === key.toLowerCase())
  return index === -1 ? PRIORITY_KEYS.length : index
}

function preferredValue(root, paths) {
  if (!isObject(root)) return ''
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => isObject(current) ? current[key] : undefined, root)
    if (isScalar(value) && value !== '') return String(value)
  }
  return ''
}

function unwrap(value) {
  let current = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isObject(current) || current.data === undefined) break
    const keys = Object.keys(current).filter(key => !['ok', 'mode', 'cached', 'disclaimer'].includes(key))
    if (keys.length !== 1 || keys[0] !== 'data') break
    current = current.data
  }
  return current
}

function cleanQuery(query) {
  if (!isObject(query)) return {}
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [key, String(value)]))
}

function sectionDescription(fields, records) {
  const parts = []
  if (fields) parts.push(`${fields} field${fields === 1 ? '' : 's'}`)
  if (records) parts.push(`${records} record${records === 1 ? '' : 's'}`)
  return parts.join(' and ') || 'No populated data'
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const number = Number(value)
    return number < 10_000_000_000 ? number * 1000 : number
  }
  return value
}

function isTimestamp(value, key) {
  return /time|date|created|updated|timestamp/i.test(key) && (typeof value === 'number' || typeof value === 'string')
}

function isNumeric(value) {
  return typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()))
}

function isScalar(value) {
  return ['string', 'number', 'boolean', 'bigint'].includes(typeof value)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function humanize(value) {
  return String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section'
}
