let nextId = 1
const jobs = new Map()

export function register(proc) {
  const id = String(nextId++)
  jobs.set(id, proc)
  proc.once('exit', () => jobs.delete(id))
  return id
}

export function cancel(id) {
  const proc = jobs.get(id)
  if (!proc) return false
  proc.kill('SIGTERM')
  setTimeout(() => {
    if (jobs.has(id)) proc.kill('SIGKILL')
  }, 5000).unref()
  return true
}

export function list() {
  return [...jobs.keys()]
}

export function reset() {
  jobs.clear()
  nextId = 1
}
