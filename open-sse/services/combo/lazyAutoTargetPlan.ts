import type { ResolvedComboTarget } from "./types.ts";

/**
 * The immutable, request-independent part of an Auto route.  In particular,
 * this deliberately contains no credentials or provider connection rows.
 * Keeping it separate from the dispatch object lets the attempt loop retain
 * the complete route without retaining one object per target.
 */
export type AutoTargetDescriptor = Readonly<ResolvedComboTarget>;

export type LazyAutoTargetPlan = {
  readonly length: number;
  readonly descriptors: readonly AutoTargetDescriptor[];
  readonly materializedCount: number;
  readonly attemptedCount: number;
  readonly peakMaterialized: number;
  descriptorAt(index: number): AutoTargetDescriptor;
  materialize(index: number): ResolvedComboTarget;
  release(index: number): void;
  markAttempt(index: number): void;
};

function copyDescriptor(target: ResolvedComboTarget): AutoTargetDescriptor {
  return Object.freeze({
    ...target,
    // Keep the allow-list semantically identical without sharing a mutable
    // array with a caller that may apply connection routing later.
    allowedConnectionIds: target.allowedConnectionIds
      ? [...target.allowedConnectionIds]
      : target.allowedConnectionIds,
  });
}

/** Create a complete ordered plan while deferring concrete target objects. */
export function createLazyAutoTargetPlan(
  targets: readonly ResolvedComboTarget[]
): LazyAutoTargetPlan {
  const descriptors = Object.freeze(targets.map(copyDescriptor));
  let materializedCount = 0;
  let attemptedCount = 0;
  let activeMaterialized = 0;
  let peakMaterialized = 0;

  return {
    get length() {
      return descriptors.length;
    },
    descriptors,
    get materializedCount() {
      return materializedCount;
    },
    get attemptedCount() {
      return attemptedCount;
    },
    get peakMaterialized() {
      return peakMaterialized;
    },
    descriptorAt(index) {
      const descriptor = descriptors[index];
      if (!descriptor) throw new RangeError(`Auto target index out of range: ${index}`);
      return descriptor;
    },
    materialize(index) {
      const descriptor = this.descriptorAt(index);
      materializedCount += 1;
      activeMaterialized += 1;
      peakMaterialized = Math.max(peakMaterialized, activeMaterialized);
      return {
        ...descriptor,
        allowedConnectionIds: descriptor.allowedConnectionIds
          ? [...descriptor.allowedConnectionIds]
          : descriptor.allowedConnectionIds,
      };
    },
    release() {
      activeMaterialized = Math.max(0, activeMaterialized - 1);
    },
    markAttempt() {
      attemptedCount += 1;
    },
  };
}
