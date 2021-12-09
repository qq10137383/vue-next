import {
  computed as _computed,
  ComputedRef,
  WritableComputedOptions,
  WritableComputedRef,
  ComputedGetter
} from '@vue/reactivity'
import { recordInstanceBoundEffect } from './component'

export function computed<T>(getter: ComputedGetter<T>): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>
) {
  // 将computed内部使用的effect增加到组件实例的effects数组中，作用是在组件销毁时
  // 将effect结束掉(effect.active=false)
  const c = _computed(getterOrOptions as any)
  recordInstanceBoundEffect(c.effect)
  return c
}
