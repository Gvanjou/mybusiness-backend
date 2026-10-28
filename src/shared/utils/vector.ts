export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// pgvector values arrive from PostgREST as "[0.1,0.2,…]"
export function parseVector(value: unknown): Float32Array | null {
  if (typeof value !== 'string' || value.length < 3) return null
  const parts = value.slice(1, -1).split(',')
  const out = new Float32Array(parts.length)
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i])
  return out
}

export function toPgVector(values: number[]): string {
  return `[${values.join(',')}]`
}
