/**
 * Structural view of a provider with per-model pricing. Kept local (rather than
 * the v1 SDK `Provider` type) so this pure helper stays host/version
 * independent; real v1/v2 provider objects are assignable to it.
 */
export interface ProviderLike {
  models?: Record<string, { cost?: { input?: number; output?: number; cache?: { read?: number } } }>
}

export function splitCost(
  deltaInput: number,
  deltaCacheRead: number,
  deltaOutput: number,
  deltaCost: number,
  modelId: string,
  provider: readonly ProviderLike[]
): { inputCost: number; outputCost: number } {
  let inputPrice = 0
  let outputPrice = 0
  let cacheReadPrice = 0

  for (const p of provider) {
    const model = p.models?.[modelId]
    if (model?.cost) {
      inputPrice = model.cost.input ?? 0
      outputPrice = model.cost.output ?? 0
      cacheReadPrice = model.cost.cache?.read ?? 0
      break
    }
  }

  // Only fall back to a raw token-proportional split when NO pricing is known
  // for this model. A zero input/output price with a non-zero cache-read price
  // is still pricing: treating it as "unpriced" would silently discard the
  // cache-read share.
  if (inputPrice === 0 && outputPrice === 0 && cacheReadPrice === 0) {
    const totalTok = deltaInput + deltaCacheRead + deltaOutput
    if (totalTok === 0) return { inputCost: 0, outputCost: 0 }
    return {
      inputCost: deltaCost * (deltaInput + deltaCacheRead) / totalTok,
      outputCost: deltaCost * deltaOutput / totalTok,
    }
  }

  // Price-weighted split
  const inputWeight = (deltaInput * inputPrice + deltaCacheRead * cacheReadPrice) / 1_000_000
  const outputWeight = (deltaOutput * outputPrice) / 1_000_000
  const totalWeight = inputWeight + outputWeight

  if (totalWeight === 0) return { inputCost: 0, outputCost: 0 }

  return {
    inputCost: deltaCost * inputWeight / totalWeight,
    outputCost: deltaCost * outputWeight / totalWeight,
  }
}

export function getCacheReadPrice(modelId: string, provider: readonly ProviderLike[]): number {
  for (const p of provider) {
    const model = p.models?.[modelId]
    if (model?.cost) {
      return model.cost.cache?.read ?? 0
    }
  }
  return 0
}

/**
 * Calculates the cache hit rate percentage.
 * Returns null when both inputs are 0 to avoid division by zero.
 */
export function calcCacheHitRate(cacheRead: number, nonCachedInput: number): number | null {
  if (cacheRead === 0 && nonCachedInput === 0) {
    return null
  }
  return Math.round((cacheRead / (cacheRead + nonCachedInput)) * 100)
}
