<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  DOCKER_CONTAINER_STATES,
  DNS_RECORD_TYPES,
  GROUP_STRATEGIES,
  HTTP_METHODS,
  MIN_INTERVAL_S,
  MONITOR_TYPES,
  createMonitor,
  errorMessage,
  fetchChannels,
  fetchDockerHosts,
  fetchMonitors,
  fetchTags,
  updateMonitor,
} from '../api.js'
import type {
  Channel,
  DockerContainerState,
  DockerHost,
  DnsRecordType,
  GroupStrategy,
  HttpMethod,
  Monitor,
  MonitorInput,
  MonitorType,
  Tag,
} from '../api.js'
import { copyText } from '../clipboard.js'
import { MONITOR_TYPE_LABELS } from '../monitorDisplay.js'
import Badge from './ui/Badge.vue'
import Button from './ui/Button.vue'
import Icon from './ui/Icon.vue'
import Input from './ui/Input.vue'
import Modal from './ui/Modal.vue'
import Select from './ui/Select.vue'
import Switch from './ui/Switch.vue'
import Textarea from './ui/Textarea.vue'
import { useToast } from './ui/toast.js'

const props = withDefaults(defineProps<{ open: boolean; monitor?: Monitor | null }>(), {
  monitor: null,
})
const emit = defineEmits<{ created: [monitor: Monitor]; saved: [monitor: Monitor]; close: [] }>()

const toast = useToast()

/** Monitor being edited; `null` keeps the form in create mode. */
const editingMonitor = computed<Monitor | null>(() => props.monitor ?? null)
const isEdit = computed(() => editingMonitor.value !== null)

const TYPE_GROUPS = [
  {
    label: 'HTTP / Push',
    options: [
      { value: 'http', label: 'HTTP — poll a URL on a schedule' },
      { value: 'push', label: 'Push — wait for an incoming heartbeat' },
    ],
  },
  {
    label: 'Network',
    options: [
      { value: 'tcp', label: 'TCP — open a socket' },
      { value: 'dns', label: 'DNS — resolve a record' },
      { value: 'icmp', label: 'ICMP — ping a host' },
    ],
  },
  {
    label: 'Databases',
    options: [
      { value: 'postgres', label: 'PostgreSQL' },
      { value: 'mysql', label: 'MySQL' },
      { value: 'mssql', label: 'SQL Server' },
      { value: 'mongodb', label: 'MongoDB' },
      { value: 'redis', label: 'Redis' },
    ],
  },
  {
    label: 'Docker',
    options: [{ value: 'docker', label: 'Docker — watch a container' }],
  },
  {
    label: 'Group',
    options: [{ value: 'group', label: 'Group — combine other monitors' }],
  },
] as const

const HTTP_METHOD_OPTIONS = HTTP_METHODS.map((method) => ({ value: method, label: method }))
const ACCEPTED_STATUS_OPTIONS = [
  { value: 'range', label: 'Status range' },
  { value: 'any', label: 'Any status' },
]
const DNS_RECORD_OPTIONS = DNS_RECORD_TYPES.map((recordType) => ({
  value: recordType,
  label: recordType,
}))
const DOCKER_STATE_OPTIONS = DOCKER_CONTAINER_STATES.map((state) => ({
  value: state,
  label: state,
}))
const GROUP_STRATEGY_OPTIONS = [
  { value: 'any-up', label: 'Any member up' },
  { value: 'all-up', label: 'All members up' },
  { value: 'percentage', label: 'Percentage of members up' },
]

function defaultFormState() {
  return {
    name: '',
    type: 'http' as MonitorType,
    intervalS: '60',
    retries: '0',
    tagText: '',
    isPublic: false,
    httpUrl: '',
    httpMethod: 'GET' as HttpMethod,
    httpAcceptedMode: 'range' as 'range' | 'any',
    httpAcceptedMin: '200',
    httpAcceptedMax: '299',
    httpHeadersText: '',
    httpBody: '',
    httpKeyword: '',
    httpKeywordInverse: false,
    httpMaxResponseMs: '',
    httpCertExpiryDays: '',
    httpTimeoutMs: '10000',
    pushGraceSeconds: '60',
    pushCron: '',
    pushExpectsBody: false,
    tcpHost: '',
    tcpPort: '',
    tcpPayload: '',
    tcpExpectResponse: '',
    tcpTimeoutMs: '10000',
    dnsHost: '',
    dnsResolver: '',
    dnsPort: '',
    dnsRecordType: 'A' as DnsRecordType,
    dnsExpectedValue: '',
    dnsTimeoutMs: '10000',
    icmpHost: '',
    icmpPacketCount: '3',
    icmpTimeoutMs: '10000',
    postgresConnectionString: '',
    postgresQuery: 'SELECT 1',
    postgresTimeoutMs: '10000',
    mysqlConnectionString: '',
    mysqlQuery: 'SELECT 1',
    mysqlTimeoutMs: '10000',
    mssqlConnectionString: '',
    mssqlQuery: 'SELECT 1',
    mssqlTimeoutMs: '10000',
    mongodbConnectionString: '',
    mongodbTimeoutMs: '10000',
    redisConnectionString: '',
    redisQuery: 'PING',
    redisTimeoutMs: '10000',
    dockerHostUri: '',
    dockerContainer: '',
    dockerExpectedState: 'running' as DockerContainerState,
    dockerTlsOpen: false,
    dockerTlsCa: '',
    dockerTlsCert: '',
    dockerTlsKey: '',
    dockerTimeoutMs: '10000',
    groupMemberIds: [] as number[],
    groupStrategy: 'any-up' as GroupStrategy,
    groupPercentage: '80',
  }
}

const form = reactive(defaultFormState())
const errors = reactive<Record<string, string | null>>({})

const optionsLoading = ref(false)
const optionsError = ref<string | null>(null)
const tags = ref<Tag[]>([])
const channels = ref<Channel[]>([])
const dockerHosts = ref<DockerHost[]>([])

const dockerHostOptions = computed(() =>
  dockerHosts.value.map((host) => ({ value: host.uri, label: host.name })),
)

function applyDockerHost(uri: string): void {
  if (uri !== '') form.dockerHostUri = uri
}
const monitors = ref<Monitor[]>([])
const selectedChannelIds = ref<number[]>([])
const submitting = ref(false)
const formError = ref<string | null>(null)
const created = ref<Monitor | null>(null)

const modalTitle = computed(() => {
  if (created.value !== null) return 'Monitor created'
  return isEdit.value ? 'Edit monitor' : 'Add monitor'
})

const intervalLabel = computed(() =>
  form.type === 'push' ? 'Expected interval' : 'Check interval',
)

/** Monitors a group can combine: no groups (no nesting) and never the group itself. */
const memberChoices = computed(() => {
  const editing = editingMonitor.value
  return monitors.value.filter((monitor) => monitor.type !== 'group' && monitor.id !== editing?.id)
})

/** Tag names typed into the input; the server creates unknown tags implicitly. */
function parseTagNames(value: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const chunk of value.split(',')) {
    const name = chunk.trim()
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

const tagNames = computed(() => parseTagNames(form.tagText))

function isTagSelected(tag: Tag): boolean {
  return tagNames.value.some((name) => name.toLowerCase() === tag.name.toLowerCase())
}

function toggleTag(tag: Tag): void {
  const selected = isTagSelected(tag)
  const names = selected
    ? tagNames.value.filter((name) => name.toLowerCase() !== tag.name.toLowerCase())
    : [...tagNames.value, tag.name]
  form.tagText = names.join(', ')
}

function isChannelSelected(id: number): boolean {
  return selectedChannelIds.value.includes(id)
}

function toggleChannel(id: number): void {
  selectedChannelIds.value = isChannelSelected(id)
    ? selectedChannelIds.value.filter((item) => item !== id)
    : [...selectedChannelIds.value, id]
}

function isMemberSelected(id: number): boolean {
  return form.groupMemberIds.includes(id)
}

function toggleMember(id: number): void {
  form.groupMemberIds = isMemberSelected(id)
    ? form.groupMemberIds.filter((item) => item !== id)
    : [...form.groupMemberIds, id]
}

const pushUrl = computed(() => {
  const url = created.value?.pushUrl
  if (url === undefined) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
})

/* Validation helpers */

function clearErrors(): void {
  for (const key of Object.keys(errors)) errors[key] = null
}

function pickOption<T extends string>(allowed: readonly T[], value: string): T | null {
  return (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function integerAtLeast(value: string, min: number): number | null {
  const parsed = Number(value)
  if (value.trim() === '' || !Number.isInteger(parsed) || parsed < min) return null
  return parsed
}

function integerBetween(value: string, min: number, max: number): number | null {
  const parsed = integerAtLeast(value, min)
  return parsed !== null && parsed <= max ? parsed : null
}

/** Blank means "leave the key out"; an invalid number returns null. */
function optionalInteger(value: string, min: number): number | null | undefined {
  if (value.trim() === '') return undefined
  return integerAtLeast(value, min)
}

/** Mirrors the server's hostname rules: non-empty, no whitespace, no leading "-". */
function validHost(value: string): boolean {
  return value !== '' && !/\s/.test(value) && !value.startsWith('-')
}

function isValidCron(value: string): boolean {
  const fields = value.trim().split(/\s+/)
  if (fields.length !== 5 && fields.length !== 6) return false
  return fields.every((field) => /^[0-9*/,-]+$/.test(field))
}

function isDockerHostUri(value: string): boolean {
  if (value.startsWith('unix://')) return value.length > 'unix://'.length
  if (!value.startsWith('tcp://')) return false
  try {
    return new URL(value).hostname !== ''
  } catch {
    return false
  }
}

function timeoutValue(value: number | undefined): string {
  return value === undefined ? '10000' : String(value)
}

function setType(value: string): void {
  const next = pickOption(MONITOR_TYPES, value)
  if (next !== null) form.type = next
}

function setHttpMethod(value: string): void {
  const next = pickOption(HTTP_METHODS, value)
  if (next !== null) form.httpMethod = next
}

function setAcceptedMode(value: string): void {
  if (value === 'range' || value === 'any') form.httpAcceptedMode = value
}

function setDnsRecordType(value: string): void {
  const next = pickOption(DNS_RECORD_TYPES, value)
  if (next !== null) form.dnsRecordType = next
}

function setDockerState(value: string): void {
  const next = pickOption(DOCKER_CONTAINER_STATES, value)
  if (next !== null) form.dockerExpectedState = next
}

function setGroupStrategy(value: string): void {
  const next = pickOption(GROUP_STRATEGIES, value)
  if (next !== null) form.groupStrategy = next
}

function formatHeaders(headers: Record<string, string> | undefined): string {
  if (headers === undefined) return ''
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

function parseHeaders(value: string): Record<string, string> | null {
  const headers: Record<string, string> = {}
  for (const line of value.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const separator = trimmed.indexOf(':')
    if (separator <= 0) return null
    headers[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
  }
  return headers
}

/* Config builders, one per type. Each returns `null` after recording field errors. */

function buildHttpConfig(): Record<string, unknown> | null {
  const url = form.httpUrl.trim()
  if (url === '') {
    errors.httpUrl = 'Enter the URL to check.'
  } else {
    try {
      const parsed = new URL(url)
      errors.httpUrl =
        parsed.protocol === 'http:' || parsed.protocol === 'https:'
          ? null
          : 'Use an http or https URL.'
    } catch {
      errors.httpUrl = 'Enter a valid absolute URL.'
    }
  }

  const timeoutMs = integerAtLeast(form.httpTimeoutMs, 1)
  errors.httpTimeoutMs = timeoutMs === null ? 'Enter a timeout of at least 1 ms.' : null

  const min = integerBetween(form.httpAcceptedMin, 100, 599)
  const max = integerBetween(form.httpAcceptedMax, 100, 599)
  if (form.httpAcceptedMode === 'range') {
    errors.httpAcceptedMin = min === null ? 'Enter a status code between 100 and 599.' : null
    errors.httpAcceptedMax = max === null ? 'Enter a status code between 100 and 599.' : null
    if (min !== null && max !== null && min > max) {
      errors.httpAcceptedMax = 'The upper bound must be at least the lower bound.'
    }
  }

  const headers = parseHeaders(form.httpHeadersText)
  errors.httpHeadersText = headers === null ? 'Enter one “Name: value” header per line.' : null

  const maxResponseMs = optionalInteger(form.httpMaxResponseMs, 1)
  errors.httpMaxResponseMs = maxResponseMs === null ? 'Enter a number of milliseconds.' : null
  const certExpiryDays = optionalInteger(form.httpCertExpiryDays, 1)
  errors.httpCertExpiryDays = certExpiryDays === null ? 'Enter a number of days.' : null

  if (
    errors.httpUrl !== null ||
    errors.httpTimeoutMs !== null ||
    errors.httpAcceptedMin !== null ||
    errors.httpAcceptedMax !== null ||
    errors.httpHeadersText !== null ||
    errors.httpMaxResponseMs !== null ||
    errors.httpCertExpiryDays !== null
  ) {
    return null
  }

  const keyword = form.httpKeyword.trim()
  const sendsBody =
    form.httpMethod === 'POST' || form.httpMethod === 'PUT' || form.httpMethod === 'DELETE'
  return {
    url,
    method: form.httpMethod,
    timeoutMs,
    acceptedStatus: form.httpAcceptedMode === 'any' ? 'any' : ([min, max] as [number, number]),
    ...(headers !== null && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(sendsBody && form.httpBody !== '' ? { body: form.httpBody } : {}),
    ...(keyword === ''
      ? {}
      : {
          keyword: form.httpKeywordInverse ? { value: keyword, inverse: true } : { value: keyword },
        }),
    ...(maxResponseMs === undefined ? {} : { maxResponseMs }),
    ...(certExpiryDays === undefined ? {} : { certExpiryDays }),
  }
}

function buildPushConfig(): Record<string, unknown> | null {
  const graceSeconds = integerAtLeast(form.pushGraceSeconds, 1)
  errors.pushGraceSeconds = graceSeconds === null ? 'Enter a grace period of at least 1 s.' : null

  const cron = form.pushCron.trim()
  errors.pushCron =
    cron !== '' && !isValidCron(cron)
      ? 'Use 5 or 6 whitespace-separated fields, e.g. 0 3 * * *.'
      : null

  if (errors.pushGraceSeconds !== null || errors.pushCron !== null) return null
  return {
    graceSeconds,
    ...(cron === '' ? {} : { cron }),
    ...(form.pushExpectsBody ? { expectsBody: true } : {}),
  }
}

function buildTcpConfig(): Record<string, unknown> | null {
  const host = form.tcpHost.trim()
  if (host === '') {
    errors.tcpHost = 'Enter the host to connect to.'
  } else if (!validHost(host)) {
    errors.tcpHost = 'Enter a hostname or IP address without spaces.'
  } else {
    errors.tcpHost = null
  }

  const port = integerBetween(form.tcpPort, 1, 65535)
  errors.tcpPort = port === null ? 'Enter a port between 1 and 65535.' : null
  const timeoutMs = integerAtLeast(form.tcpTimeoutMs, 1)
  errors.tcpTimeoutMs = timeoutMs === null ? 'Enter a timeout of at least 1 ms.' : null

  if (errors.tcpHost !== null || errors.tcpPort !== null || errors.tcpTimeoutMs !== null) {
    return null
  }

  const expectResponse = form.tcpExpectResponse.trim()
  return {
    host,
    port,
    timeoutMs,
    ...(form.tcpPayload === '' ? {} : { payload: form.tcpPayload }),
    ...(expectResponse === '' ? {} : { expectResponse }),
  }
}

function buildDnsConfig(): Record<string, unknown> | null {
  const host = form.dnsHost.trim()
  if (host === '') {
    errors.dnsHost = 'Enter the hostname to resolve.'
  } else if (!validHost(host)) {
    errors.dnsHost = 'Enter a hostname without spaces.'
  } else {
    errors.dnsHost = null
  }

  const port = form.dnsPort.trim() === '' ? undefined : integerBetween(form.dnsPort, 1, 65535)
  errors.dnsPort = port === null ? 'Enter a port between 1 and 65535.' : null
  const timeoutMs = integerAtLeast(form.dnsTimeoutMs, 1)
  errors.dnsTimeoutMs = timeoutMs === null ? 'Enter a timeout of at least 1 ms.' : null

  if (errors.dnsHost !== null || errors.dnsPort !== null || errors.dnsTimeoutMs !== null) {
    return null
  }

  const resolver = form.dnsResolver.trim()
  const expectedValue = form.dnsExpectedValue.trim()
  return {
    host,
    recordType: form.dnsRecordType,
    timeoutMs,
    ...(resolver === '' ? {} : { resolver }),
    ...(port === undefined ? {} : { port }),
    ...(expectedValue === '' ? {} : { expectedValue }),
  }
}

function buildIcmpConfig(): Record<string, unknown> | null {
  const host = form.icmpHost.trim()
  if (host === '') {
    errors.icmpHost = 'Enter the host to ping.'
  } else if (!validHost(host)) {
    errors.icmpHost = 'Enter a hostname or IP address without spaces.'
  } else {
    errors.icmpHost = null
  }

  const packetCount = integerBetween(form.icmpPacketCount, 1, 10)
  errors.icmpPacketCount = packetCount === null ? 'Enter between 1 and 10 packets.' : null
  const timeoutMs = integerAtLeast(form.icmpTimeoutMs, 1)
  errors.icmpTimeoutMs = timeoutMs === null ? 'Enter a timeout of at least 1 ms.' : null

  if (
    errors.icmpHost !== null ||
    errors.icmpPacketCount !== null ||
    errors.icmpTimeoutMs !== null
  ) {
    return null
  }
  return { host, timeoutMs, packetCount }
}

function buildSqlConfig(
  type: 'postgres' | 'mysql' | 'mssql',
  connectionString: string,
  query: string,
  timeoutMsValue: string,
): Record<string, unknown> | null {
  const trimmed = connectionString.trim()
  errors[`${type}ConnectionString`] = trimmed === '' ? 'Enter the connection string.' : null
  const timeoutMs = integerAtLeast(timeoutMsValue, 1)
  errors[`${type}TimeoutMs`] = timeoutMs === null ? 'Enter a timeout of at least 1 ms.' : null

  if (errors[`${type}ConnectionString`] !== null || errors[`${type}TimeoutMs`] !== null) {
    return null
  }

  const trimmedQuery = query.trim()
  return {
    connectionString: trimmed,
    timeoutMs,
    ...(trimmedQuery === '' ? {} : { query: trimmedQuery }),
  }
}

function buildMongodbConfig(): Record<string, unknown> | null {
  const connectionString = form.mongodbConnectionString.trim()
  errors.mongodbConnectionString = connectionString === '' ? 'Enter the connection string.' : null
  const timeoutMs = integerAtLeast(form.mongodbTimeoutMs, 1)
  errors.mongodbTimeoutMs = timeoutMs === null ? 'Enter a timeout of at least 1 ms.' : null

  if (errors.mongodbConnectionString !== null || errors.mongodbTimeoutMs !== null) return null
  return { connectionString, timeoutMs }
}

function buildRedisConfig(): Record<string, unknown> | null {
  const connectionString = form.redisConnectionString.trim()
  errors.redisConnectionString = connectionString === '' ? 'Enter the connection string.' : null
  const timeoutMs = integerAtLeast(form.redisTimeoutMs, 1)
  errors.redisTimeoutMs = timeoutMs === null ? 'Enter a timeout of at least 1 ms.' : null

  if (errors.redisConnectionString !== null || errors.redisTimeoutMs !== null) return null

  const query = form.redisQuery.trim()
  return {
    connectionString,
    timeoutMs,
    ...(query === '' ? {} : { query }),
  }
}

function buildDockerConfig(): Record<string, unknown> | null {
  const hostUri = form.dockerHostUri.trim()
  errors.dockerHostUri = isDockerHostUri(hostUri)
    ? null
    : 'Enter a unix:// path or a tcp://host:port URL.'

  const container = form.dockerContainer.trim()
  errors.dockerContainer = container === '' ? 'Enter the container name or id.' : null
  const timeoutMs = integerAtLeast(form.dockerTimeoutMs, 1)
  errors.dockerTimeoutMs = timeoutMs === null ? 'Enter a timeout of at least 1 ms.' : null

  if (
    errors.dockerHostUri !== null ||
    errors.dockerContainer !== null ||
    errors.dockerTimeoutMs !== null
  ) {
    return null
  }

  const tlsCaPem = form.dockerTlsCa.trim()
  const tlsCertPem = form.dockerTlsCert.trim()
  const tlsKeyPem = form.dockerTlsKey.trim()
  return {
    hostUri,
    containerNameOrId: container,
    expectedState: form.dockerExpectedState,
    timeoutMs,
    ...(tlsCaPem === '' ? {} : { tlsCaPem }),
    ...(tlsCertPem === '' ? {} : { tlsCertPem }),
    ...(tlsKeyPem === '' ? {} : { tlsKeyPem }),
  }
}

function buildGroupConfig(): Record<string, unknown> | null {
  errors.groupMembers =
    form.groupMemberIds.length === 0 ? 'Select at least one member monitor.' : null

  if (form.groupStrategy === 'percentage') {
    const percentage = integerBetween(form.groupPercentage, 0, 100)
    errors.groupPercentage = percentage === null ? 'Enter a percentage between 0 and 100.' : null
    if (errors.groupMembers !== null || errors.groupPercentage !== null) return null
    return {
      memberIds: [...form.groupMemberIds],
      strategy: form.groupStrategy,
      percentage: percentage as number,
    }
  }

  errors.groupPercentage = null
  if (errors.groupMembers !== null) return null
  return { memberIds: [...form.groupMemberIds], strategy: form.groupStrategy }
}

function buildConfig(): Record<string, unknown> | null {
  switch (form.type) {
    case 'http':
      return buildHttpConfig()
    case 'push':
      return buildPushConfig()
    case 'tcp':
      return buildTcpConfig()
    case 'dns':
      return buildDnsConfig()
    case 'icmp':
      return buildIcmpConfig()
    case 'postgres':
      return buildSqlConfig(
        'postgres',
        form.postgresConnectionString,
        form.postgresQuery,
        form.postgresTimeoutMs,
      )
    case 'mysql':
      return buildSqlConfig(
        'mysql',
        form.mysqlConnectionString,
        form.mysqlQuery,
        form.mysqlTimeoutMs,
      )
    case 'mssql':
      return buildSqlConfig(
        'mssql',
        form.mssqlConnectionString,
        form.mssqlQuery,
        form.mssqlTimeoutMs,
      )
    case 'mongodb':
      return buildMongodbConfig()
    case 'redis':
      return buildRedisConfig()
    case 'docker':
      return buildDockerConfig()
    case 'group':
      return buildGroupConfig()
  }
}

/* Prefill and reset */

function prefillFrom(monitor: Monitor): void {
  form.name = monitor.name
  form.type = monitor.type
  form.intervalS = String(monitor.intervalS)
  form.retries = String(monitor.retries)
  form.tagText = monitor.tags.map((tag) => tag.name).join(', ')
  form.isPublic = monitor.isPublic
  selectedChannelIds.value = [...monitor.channelIds]

  switch (monitor.type) {
    case 'http': {
      const config = monitor.config
      form.httpUrl = config.url
      form.httpMethod = config.method ?? 'GET'
      const accepted = config.acceptedStatus ?? [200, 299]
      if (accepted === 'any') {
        form.httpAcceptedMode = 'any'
      } else {
        form.httpAcceptedMode = 'range'
        form.httpAcceptedMin = String(accepted[0])
        form.httpAcceptedMax = String(accepted[1])
      }
      form.httpHeadersText = formatHeaders(config.headers)
      form.httpBody = config.body ?? ''
      form.httpKeyword = config.keyword?.value ?? ''
      form.httpKeywordInverse = config.keyword?.inverse ?? false
      form.httpMaxResponseMs =
        config.maxResponseMs === undefined ? '' : String(config.maxResponseMs)
      form.httpCertExpiryDays =
        config.certExpiryDays === undefined ? '' : String(config.certExpiryDays)
      form.httpTimeoutMs = timeoutValue(config.timeoutMs)
      break
    }
    case 'push': {
      const config = monitor.config
      form.pushGraceSeconds = config.graceSeconds === undefined ? '60' : String(config.graceSeconds)
      form.pushCron = config.cron ?? ''
      form.pushExpectsBody = config.expectsBody ?? false
      break
    }
    case 'tcp': {
      const config = monitor.config
      form.tcpHost = config.host
      form.tcpPort = String(config.port)
      form.tcpPayload = config.payload ?? ''
      form.tcpExpectResponse = config.expectResponse ?? ''
      form.tcpTimeoutMs = timeoutValue(config.timeoutMs)
      break
    }
    case 'dns': {
      const config = monitor.config
      form.dnsHost = config.host
      form.dnsResolver = config.resolver ?? ''
      form.dnsPort = config.port === undefined ? '' : String(config.port)
      form.dnsRecordType = config.recordType
      form.dnsExpectedValue = config.expectedValue ?? ''
      form.dnsTimeoutMs = timeoutValue(config.timeoutMs)
      break
    }
    case 'icmp': {
      const config = monitor.config
      form.icmpHost = config.host
      form.icmpPacketCount = config.packetCount === undefined ? '3' : String(config.packetCount)
      form.icmpTimeoutMs = timeoutValue(config.timeoutMs)
      break
    }
    case 'postgres': {
      const config = monitor.config
      form.postgresConnectionString = config.connectionString
      form.postgresQuery = config.query ?? 'SELECT 1'
      form.postgresTimeoutMs = timeoutValue(config.timeoutMs)
      break
    }
    case 'mysql': {
      const config = monitor.config
      form.mysqlConnectionString = config.connectionString
      form.mysqlQuery = config.query ?? 'SELECT 1'
      form.mysqlTimeoutMs = timeoutValue(config.timeoutMs)
      break
    }
    case 'mssql': {
      const config = monitor.config
      form.mssqlConnectionString = config.connectionString
      form.mssqlQuery = config.query ?? 'SELECT 1'
      form.mssqlTimeoutMs = timeoutValue(config.timeoutMs)
      break
    }
    case 'mongodb': {
      const config = monitor.config
      form.mongodbConnectionString = config.connectionString
      form.mongodbTimeoutMs = timeoutValue(config.timeoutMs)
      break
    }
    case 'redis': {
      const config = monitor.config
      form.redisConnectionString = config.connectionString
      form.redisQuery = config.query ?? 'PING'
      form.redisTimeoutMs = timeoutValue(config.timeoutMs)
      break
    }
    case 'docker': {
      const config = monitor.config
      form.dockerHostUri = config.hostUri
      form.dockerContainer = config.containerNameOrId
      form.dockerExpectedState = config.expectedState ?? 'running'
      form.dockerTlsOpen =
        config.tlsCaPem !== undefined ||
        config.tlsCertPem !== undefined ||
        config.tlsKeyPem !== undefined
      form.dockerTlsCa = config.tlsCaPem ?? ''
      form.dockerTlsCert = config.tlsCertPem ?? ''
      form.dockerTlsKey = config.tlsKeyPem ?? ''
      form.dockerTimeoutMs = timeoutValue(config.timeoutMs)
      break
    }
    case 'group': {
      const config = monitor.config
      form.groupMemberIds = [...config.memberIds]
      form.groupStrategy = config.strategy
      form.groupPercentage = config.percentage === undefined ? '80' : String(config.percentage)
      break
    }
  }
}

function reset(): void {
  Object.assign(form, defaultFormState())
  clearErrors()
  selectedChannelIds.value = []
  formError.value = null
  created.value = null
}

async function loadOptions(): Promise<void> {
  optionsLoading.value = true
  optionsError.value = null
  try {
    const [loadedTags, loadedChannels, loadedMonitors, loadedDockerHosts] = await Promise.all([
      fetchTags(),
      fetchChannels(),
      fetchMonitors(),
      fetchDockerHosts(),
    ])
    tags.value = loadedTags
    dockerHosts.value = loadedDockerHosts
    channels.value = loadedChannels
    monitors.value = loadedMonitors
  } catch (error) {
    optionsError.value = errorMessage(error, 'Could not load tags, channels and monitors.')
  } finally {
    optionsLoading.value = false
  }
}

/** Changes only when the dialog opens/closes or is repointed at another monitor. */
const prefillKey = computed(() => {
  if (!props.open) return null
  const monitor = editingMonitor.value
  return monitor === null ? 'create' : `edit:${monitor.id}`
})

watch(prefillKey, (key) => {
  if (key === null) return
  reset()
  const monitor = editingMonitor.value
  if (monitor !== null) prefillFrom(monitor)
  void loadOptions()
})

function buildPayload(): MonitorInput | null {
  clearErrors()
  errors.name = form.name.trim() === '' ? 'Enter a name.' : null

  const config = buildConfig()

  const intervalS = integerAtLeast(form.intervalS, MIN_INTERVAL_S)
  errors.intervalS =
    intervalS === null ? `Enter an interval of at least ${MIN_INTERVAL_S} s.` : null

  const retries = integerAtLeast(form.retries, 0)
  errors.retries = retries === null ? 'Enter zero or more retries.' : null

  if (
    config === null ||
    errors.name !== null ||
    errors.intervalS !== null ||
    errors.retries !== null
  ) {
    return null
  }

  const names = tagNames.value
  return {
    name: form.name.trim(),
    type: form.type,
    config,
    intervalS: intervalS as number,
    retries: retries as number,
    isPublic: form.isPublic,
    channelIds: selectedChannelIds.value,
    ...(names.length === 0 ? {} : { tags: names }),
  }
}

async function submit(): Promise<void> {
  submitting.value = true
  formError.value = null
  try {
    const payload = buildPayload()
    if (payload === null) return

    const editing = editingMonitor.value
    if (editing !== null) {
      const updated = await updateMonitor(editing.id, payload)
      emit('saved', updated)
      toast.success('Monitor updated', updated.name)
      emit('close')
      return
    }
    const monitor = await createMonitor(payload)
    created.value = monitor
    emit('created', monitor)
    if (monitor.pushUrl === undefined) emit('close')
  } catch (error) {
    const fallback = isEdit.value ? 'Could not save the monitor.' : 'Could not create the monitor.'
    formError.value = errorMessage(error, fallback)
    toast.error(fallback, formError.value)
  } finally {
    submitting.value = false
  }
}

async function copyPushUrl(): Promise<void> {
  if (pushUrl.value === null) return
  const copied = await copyText(pushUrl.value)
  if (copied) {
    toast.success('Push URL copied')
    return
  }
  toast.error('Copy failed', 'Select the URL and copy it manually.')
}
</script>

<template>
  <Modal
    :open="open"
    :title="modalTitle"
    size="lg"
    :close-on-backdrop="created === null"
    @close="emit('close')"
  >
    <div v-if="created !== null" class="created">
      <p class="created-lead">
        <Badge variant="success" dot>Active</Badge>
        <span class="created-name">{{ created.name }}</span>
      </p>
      <template v-if="pushUrl !== null">
        <p class="created-copy">
          Send a GET or POST request to this URL on every heartbeat. The monitor turns down once the
          grace period passes without a heartbeat.
        </p>
        <div class="copy-row">
          <code class="copy-value mono">{{ pushUrl }}</code>
          <Button variant="secondary" size="sm" @click="copyPushUrl">
            <Icon name="copy" :size="14" />
            Copy
          </Button>
        </div>
      </template>
      <p v-else class="created-copy">
        The monitor is checking now. Heartbeats appear on the dashboard after the first run.
      </p>
    </div>

    <form v-else class="monitor-form" novalidate @submit.prevent="submit">
      <div class="form-grid">
        <Input
          v-model="form.name"
          label="Name"
          placeholder="Marketing site"
          :error="errors.name"
          required
        />
        <Select
          :model-value="form.type"
          label="Type"
          :groups="TYPE_GROUPS"
          @update:model-value="setType"
        />
      </div>

      <template v-if="form.type === 'http'">
        <Input
          v-model="form.httpUrl"
          label="URL"
          type="url"
          placeholder="https://example.com"
          autocomplete="off"
          :error="errors.httpUrl"
          required
        />
        <div class="form-grid">
          <Select
            :model-value="form.httpMethod"
            label="Method"
            :options="HTTP_METHOD_OPTIONS"
            @update:model-value="setHttpMethod"
          />
          <Input
            v-model="form.httpTimeoutMs"
            label="Timeout"
            type="number"
            min="1"
            step="500"
            hint="Request timeout in milliseconds."
            :error="errors.httpTimeoutMs"
          />
        </div>
        <div class="form-grid">
          <Select
            :model-value="form.httpAcceptedMode"
            label="Accepted status"
            :options="ACCEPTED_STATUS_OPTIONS"
            @update:model-value="setAcceptedMode"
          />
          <template v-if="form.httpAcceptedMode === 'range'">
            <Input
              v-model="form.httpAcceptedMin"
              label="Status from"
              type="number"
              min="100"
              max="599"
              :error="errors.httpAcceptedMin"
            />
            <Input
              v-model="form.httpAcceptedMax"
              label="Status to"
              type="number"
              min="100"
              max="599"
              :error="errors.httpAcceptedMax"
            />
          </template>
        </div>
        <Textarea
          v-model="form.httpHeadersText"
          label="Headers"
          :rows="3"
          mono
          placeholder="Authorization: Bearer token"
          hint="Optional; one “Name: value” header per line."
          :error="errors.httpHeadersText"
        />
        <Textarea
          v-if="form.httpMethod !== 'GET' && form.httpMethod !== 'HEAD'"
          v-model="form.httpBody"
          label="Request body"
          :rows="3"
          mono
          hint="Optional body sent with the request."
        />
        <div class="form-grid">
          <Input
            v-model="form.httpKeyword"
            label="Keyword"
            placeholder="Signed in"
            hint="Optional text the response must contain."
          />
          <Input
            v-model="form.httpMaxResponseMs"
            label="Max response time"
            type="number"
            min="1"
            step="100"
            hint="Optional cap in milliseconds."
            :error="errors.httpMaxResponseMs"
          />
          <Input
            v-model="form.httpCertExpiryDays"
            label="Certificate expiry"
            type="number"
            min="1"
            step="1"
            hint="Optional minimum TLS validity in days (https only)."
            :error="errors.httpCertExpiryDays"
          />
        </div>
        <Switch
          v-model="form.httpKeywordInverse"
          label="Invert keyword"
          hint="Fail when the keyword is present instead of absent."
        />
      </template>

      <template v-else-if="form.type === 'push'">
        <div class="form-grid">
          <Input
            v-model="form.pushGraceSeconds"
            label="Grace period"
            type="number"
            min="1"
            step="10"
            hint="Extra time allowed on top of the interval before the monitor is marked down."
            :error="errors.pushGraceSeconds"
          />
          <Input
            v-model="form.pushCron"
            label="Cron schedule"
            placeholder="0 3 * * *"
            hint="Optional; expected heartbeat times (5 or 6 fields)."
            :error="errors.pushCron"
          />
        </div>
        <Switch
          v-model="form.pushExpectsBody"
          label="Require heartbeat body"
          hint="Reject heartbeats that arrive without a request body."
        />
      </template>

      <template v-else-if="form.type === 'tcp'">
        <div class="form-grid">
          <Input
            v-model="form.tcpHost"
            label="Host"
            placeholder="db.internal"
            autocomplete="off"
            :error="errors.tcpHost"
            required
          />
          <Input
            v-model="form.tcpPort"
            label="Port"
            type="number"
            min="1"
            max="65535"
            placeholder="5432"
            :error="errors.tcpPort"
            required
          />
        </div>
        <Textarea
          v-model="form.tcpPayload"
          label="Payload"
          :rows="2"
          mono
          hint="Optional data written to the socket after connecting."
        />
        <Input
          v-model="form.tcpExpectResponse"
          label="Expected response"
          hint="Optional substring the response must contain."
        />
        <Input
          v-model="form.tcpTimeoutMs"
          label="Timeout"
          type="number"
          min="1"
          step="500"
          hint="Connect and response timeout in milliseconds."
          :error="errors.tcpTimeoutMs"
        />
      </template>

      <template v-else-if="form.type === 'dns'">
        <div class="form-grid">
          <Input
            v-model="form.dnsHost"
            label="Host"
            placeholder="example.com"
            autocomplete="off"
            :error="errors.dnsHost"
            required
          />
          <Select
            :model-value="form.dnsRecordType"
            label="Record type"
            :options="DNS_RECORD_OPTIONS"
            @update:model-value="setDnsRecordType"
          />
        </div>
        <div class="form-grid">
          <Input
            v-model="form.dnsResolver"
            label="Resolver"
            placeholder="1.1.1.1"
            hint="Optional custom resolver, host[:port]."
          />
          <Input
            v-model="form.dnsPort"
            label="Resolver port"
            type="number"
            min="1"
            max="65535"
            placeholder="53"
            :error="errors.dnsPort"
          />
          <Input
            v-model="form.dnsTimeoutMs"
            label="Timeout"
            type="number"
            min="1"
            step="500"
            hint="Query timeout in milliseconds."
            :error="errors.dnsTimeoutMs"
          />
        </div>
        <Input
          v-model="form.dnsExpectedValue"
          label="Expected value"
          hint="Optional answer the resolver must return."
        />
      </template>

      <template v-else-if="form.type === 'icmp'">
        <div class="form-grid">
          <Input
            v-model="form.icmpHost"
            label="Host"
            placeholder="10.0.0.1"
            autocomplete="off"
            :error="errors.icmpHost"
            required
          />
          <Input
            v-model="form.icmpPacketCount"
            label="Packets"
            type="number"
            min="1"
            max="10"
            hint="Echo requests per probe (1–10)."
            :error="errors.icmpPacketCount"
          />
        </div>
        <Input
          v-model="form.icmpTimeoutMs"
          label="Timeout"
          type="number"
          min="1"
          step="500"
          hint="Probe timeout in milliseconds."
          :error="errors.icmpTimeoutMs"
        />
      </template>

      <template v-else-if="form.type === 'postgres'">
        <Input
          v-model="form.postgresConnectionString"
          label="Connection string"
          placeholder="postgres://user:password@host:5432/db"
          autocomplete="off"
          mono
          hint="Stored encrypted at rest."
          :error="errors.postgresConnectionString"
          required
        />
        <div class="form-grid">
          <Input
            v-model="form.postgresTimeoutMs"
            label="Timeout"
            type="number"
            min="1"
            step="500"
            hint="Query timeout in milliseconds."
            :error="errors.postgresTimeoutMs"
          />
          <Input
            v-model="form.postgresQuery"
            label="Query"
            placeholder="SELECT 1"
            mono
            hint="Statement run on every check."
          />
        </div>
      </template>

      <template v-else-if="form.type === 'mysql'">
        <Input
          v-model="form.mysqlConnectionString"
          label="Connection string"
          placeholder="mysql://user:password@host:3306/db"
          autocomplete="off"
          mono
          hint="Stored encrypted at rest."
          :error="errors.mysqlConnectionString"
          required
        />
        <div class="form-grid">
          <Input
            v-model="form.mysqlTimeoutMs"
            label="Timeout"
            type="number"
            min="1"
            step="500"
            hint="Query timeout in milliseconds."
            :error="errors.mysqlTimeoutMs"
          />
          <Input
            v-model="form.mysqlQuery"
            label="Query"
            placeholder="SELECT 1"
            mono
            hint="Statement run on every check."
          />
        </div>
      </template>

      <template v-else-if="form.type === 'mssql'">
        <Input
          v-model="form.mssqlConnectionString"
          label="Connection string"
          placeholder="Server=host,1433;Database=app;User Id=user;Password=secret"
          autocomplete="off"
          mono
          hint="Stored encrypted at rest."
          :error="errors.mssqlConnectionString"
          required
        />
        <div class="form-grid">
          <Input
            v-model="form.mssqlTimeoutMs"
            label="Timeout"
            type="number"
            min="1"
            step="500"
            hint="Query timeout in milliseconds."
            :error="errors.mssqlTimeoutMs"
          />
          <Input
            v-model="form.mssqlQuery"
            label="Query"
            placeholder="SELECT 1"
            mono
            hint="Statement run on every check."
          />
        </div>
      </template>

      <template v-else-if="form.type === 'mongodb'">
        <Input
          v-model="form.mongodbConnectionString"
          label="Connection string"
          placeholder="mongodb://user:password@host:27017/db"
          autocomplete="off"
          mono
          hint="Stored encrypted at rest."
          :error="errors.mongodbConnectionString"
          required
        />
        <Input
          v-model="form.mongodbTimeoutMs"
          label="Timeout"
          type="number"
          min="1"
          step="500"
          hint="Connection timeout in milliseconds."
          :error="errors.mongodbTimeoutMs"
        />
      </template>

      <template v-else-if="form.type === 'redis'">
        <Input
          v-model="form.redisConnectionString"
          label="Connection string"
          placeholder="redis://user:password@host:6379/0"
          autocomplete="off"
          mono
          hint="Stored encrypted at rest."
          :error="errors.redisConnectionString"
          required
        />
        <div class="form-grid">
          <Input
            v-model="form.redisTimeoutMs"
            label="Timeout"
            type="number"
            min="1"
            step="500"
            hint="Command timeout in milliseconds."
            :error="errors.redisTimeoutMs"
          />
          <Input
            v-model="form.redisQuery"
            label="Command"
            placeholder="PING"
            mono
            hint="Command sent after connecting."
          />
        </div>
      </template>

      <template v-else-if="form.type === 'docker'">
        <div class="form-grid">
          <Select
            v-if="dockerHosts.length > 0"
            label="Registered Docker hosts"
            :options="dockerHostOptions"
            placeholder="Pick a saved host…"
            hint="Fills the URI from a host saved under Settings → Docker hosts."
            @update:model-value="applyDockerHost"
          />
          <Input
            v-model="form.dockerHostUri"
            label="Docker host"
            placeholder="unix:///var/run/docker.sock"
            autocomplete="off"
            mono
            hint="unix:///path/to/docker.sock or tcp://host:2376."
            :error="errors.dockerHostUri"
            required
          />
          <Input
            v-model="form.dockerContainer"
            label="Container"
            placeholder="web"
            autocomplete="off"
            :error="errors.dockerContainer"
            required
          />
        </div>
        <div class="form-grid">
          <Select
            :model-value="form.dockerExpectedState"
            label="Expected state"
            :options="DOCKER_STATE_OPTIONS"
            @update:model-value="setDockerState"
          />
          <Input
            v-model="form.dockerTimeoutMs"
            label="Timeout"
            type="number"
            min="1"
            step="500"
            hint="Inspect timeout in milliseconds."
            :error="errors.dockerTimeoutMs"
          />
        </div>
        <div class="section">
          <button
            type="button"
            class="disclosure"
            :aria-expanded="form.dockerTlsOpen"
            @click="form.dockerTlsOpen = !form.dockerTlsOpen"
          >
            <Icon :name="form.dockerTlsOpen ? 'chevron-down' : 'chevron-right'" :size="14" />
            TLS certificates
          </button>
          <div v-if="form.dockerTlsOpen" class="stack-sm">
            <p class="section-note">
              Only needed for TLS-protected tcp:// endpoints. All PEM values are stored encrypted at
              rest.
            </p>
            <Textarea
              v-model="form.dockerTlsCa"
              label="CA bundle (PEM)"
              :rows="3"
              mono
              hint="Stored encrypted at rest."
            />
            <Textarea
              v-model="form.dockerTlsCert"
              label="Client certificate (PEM)"
              :rows="3"
              mono
              hint="Stored encrypted at rest."
            />
            <Textarea
              v-model="form.dockerTlsKey"
              label="Client key (PEM)"
              :rows="3"
              mono
              hint="Stored encrypted at rest."
            />
          </div>
        </div>
      </template>

      <template v-else-if="form.type === 'group'">
        <fieldset class="picker">
          <legend class="picker-title">Members</legend>
          <p v-if="memberChoices.length === 0" class="picker-empty">
            No other monitors available yet. Create a monitor first.
          </p>
          <ul v-else class="picker-list">
            <li v-for="member in memberChoices" :key="member.id">
              <label class="picker-row">
                <input
                  type="checkbox"
                  :checked="isMemberSelected(member.id)"
                  @change="toggleMember(member.id)"
                />
                <span class="picker-name">{{ member.name }}</span>
                <Badge variant="neutral" mono>{{ MONITOR_TYPE_LABELS[member.type] }}</Badge>
              </label>
            </li>
          </ul>
          <p class="section-note">Group monitors cannot be nested.</p>
          <p v-if="errors.groupMembers" class="form-error" role="alert">
            {{ errors.groupMembers }}
          </p>
        </fieldset>
        <div class="form-grid">
          <Select
            :model-value="form.groupStrategy"
            label="Strategy"
            :options="GROUP_STRATEGY_OPTIONS"
            @update:model-value="setGroupStrategy"
          />
          <Input
            v-if="form.groupStrategy === 'percentage'"
            v-model="form.groupPercentage"
            label="Percentage"
            type="number"
            min="0"
            max="100"
            step="1"
            hint="Share of members that must be up (0–100)."
            :error="errors.groupPercentage"
          />
        </div>
      </template>

      <div class="form-grid">
        <Input
          v-model="form.intervalS"
          :label="intervalLabel"
          type="number"
          :min="MIN_INTERVAL_S"
          step="10"
          :hint="`Seconds; minimum ${MIN_INTERVAL_S}.`"
          :error="errors.intervalS"
        />
        <Input
          v-model="form.retries"
          label="Retries"
          type="number"
          min="0"
          step="1"
          hint="Consecutive failures tolerated before an incident opens."
          :error="errors.retries"
        />
      </div>

      <div class="section">
        <p class="section-title">Tags</p>
        <Input
          v-model="form.tagText"
          placeholder="production, external"
          hint="Comma-separated; tags are created automatically when new."
        />
        <div v-if="optionsLoading" class="section-note">Loading tags…</div>
        <div v-else-if="tags.length > 0" class="chip-row">
          <button
            v-for="tag in tags"
            :key="tag.id"
            type="button"
            class="chip"
            :class="{ 'is-active': isTagSelected(tag) }"
            :aria-pressed="isTagSelected(tag)"
            @click="toggleTag(tag)"
          >
            <span class="chip-dot" :style="{ backgroundColor: tag.color }" aria-hidden="true" />
            {{ tag.name }}
          </button>
        </div>
      </div>

      <div class="section">
        <p class="section-title">Notification channels</p>
        <div v-if="optionsLoading" class="section-note">Loading channels…</div>
        <div v-else-if="channels.length === 0" class="section-note">
          No channels configured yet — add one under Notifications to get alerts.
        </div>
        <div v-else class="switch-list">
          <Switch
            v-for="channel in channels"
            :key="channel.id"
            :model-value="isChannelSelected(channel.id)"
            :label="channel.name"
            :hint="`${channel.type}${channel.isDefault ? ' · default' : ''}${channel.active ? '' : ' · inactive'}`"
            @update:model-value="toggleChannel(channel.id)"
          />
        </div>
        <p v-if="optionsError !== null" class="form-error" role="alert">{{ optionsError }}</p>
      </div>

      <div class="section">
        <p class="section-title">Visibility</p>
        <Switch
          v-model="form.isPublic"
          label="Show on the public status page"
          hint="Lists this service by name on the public status overview (/status). Targets and check details stay private."
        />
      </div>

      <p v-if="formError !== null" class="form-error" role="alert">{{ formError }}</p>
    </form>

    <template #footer>
      <template v-if="created !== null">
        <Button variant="primary" @click="emit('close')">Done</Button>
      </template>
      <template v-else>
        <Button variant="secondary" :disabled="submitting" @click="emit('close')">Cancel</Button>
        <Button variant="primary" :loading="submitting" @click="submit">
          {{ isEdit ? 'Save changes' : 'Create monitor' }}
        </Button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.monitor-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-4);
}

.stack-sm {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}

.section-title {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.section-note {
  color: var(--muted);
  font-size: 12.5px;
}

.disclosure {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 0;
  background: none;
  border: 0;
  color: var(--fg);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.disclosure:hover {
  color: var(--thread-ink);
}

.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
  padding: var(--space-3);
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.picker-title {
  padding: 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.picker-list {
  max-height: 220px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 2px;
  font-size: 13px;
  cursor: pointer;
}

.picker-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-empty {
  color: var(--muted);
  font-size: 12.5px;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  background-color: transparent;
  border: 1px solid var(--rule-2);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.chip:hover {
  color: var(--ink);
}

.chip.is-active {
  background-color: transparent;
  border-color: var(--ink);
  color: var(--ink);
}

.chip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.switch-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.form-error {
  color: var(--thread-ink);
  font-size: 13px;
}

.created {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.created-lead {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.created-name {
  font-weight: 600;
}

.created-copy {
  color: var(--muted);
  font-size: 13px;
}

.copy-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.copy-value {
  flex-grow: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
}
</style>
