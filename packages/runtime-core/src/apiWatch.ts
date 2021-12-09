import {
  effect,
  stop,
  isRef,
  Ref,
  ComputedRef,
  ReactiveEffectOptions,
  isReactive,
  ReactiveFlags
} from '@vue/reactivity'
import { SchedulerJob, queuePreFlushCb } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged,
  NOOP,
  remove,
  isMap,
  isSet,
  isPlainObject
} from '@vue/shared'
import {
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  recordInstanceBoundEffect
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'
import { DeprecationTypes } from './compat/compatConfig'
import { checkCompatEnabled, isCompatEnabled } from './compat/compatConfig'
import { ObjectWatchOptionItem } from './componentOptions'

export type WatchEffect = (onInvalidate: InvalidateCbRegistrator) => void

export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onInvalidate: InvalidateCbRegistrator
) => any

type MapSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true ? (V | undefined) : V
    : T[K] extends object
      ? Immediate extends true ? (T[K] | undefined) : T[K]
      : never
}

type InvalidateCbRegistrator = (cb: () => void) => void

export interface WatchOptionsBase {
  flush?: 'pre' | 'post' | 'sync'
  onTrack?: ReactiveEffectOptions['onTrack']
  onTrigger?: ReactiveEffectOptions['onTrigger']
}

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate
  deep?: boolean
}

export type WatchStopHandle = () => void

// 简单版本的effect
// Simple effect.
export function watchEffect(
  effect: WatchEffect,
  options?: WatchOptionsBase
): WatchStopHandle {
  return doWatch(effect, null, options)
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

type MultiWatchSources = (WatchSource<unknown> | object)[]

// overload: array of multiple sources + cb
export function watch<
  T extends MultiWatchSources,
  Immediate extends Readonly<boolean> = false
>(
  sources: [...T],
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: multiple sources w/ `as const`
// watch([foo, bar] as const, () => {})
// somehow [...T] breaks when the type is readonly
export function watch<
  T extends Readonly<MultiWatchSources>,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? (T | undefined) : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? (T | undefined) : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// implementation
export function watch<T = any, Immediate extends Readonly<boolean> = false>(
  source: T | WatchSource<T>,
  cb: any,
  options?: WatchOptions<Immediate>
): WatchStopHandle {
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source as any, cb, options)
}

// 包装effect函数，增加扩展功能，监听响应式对象(默认转为函数)，深度监听(deep)，延迟执行等
// 1.监听reactive包装的对象，是深度监听的，所以对象任何一个属性的改变，都会回调，deep属性无效，immediate属性有效
// 2.监听ref包装的对象，默认是浅监听，deep为true时是深度监听，deep、immediate属性都有效
// 3.监听对象是函数时，默认是浅监听，deep为true时是深度监听，deep、immediate属性都有效，函数调用中使用的变量必须是响应式的(ref、reactive)
function doWatch(
  source: WatchSource | WatchSource[] | WatchEffect | object,
  cb: WatchCallback | null,
  { immediate, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ,
  instance = currentInstance
): WatchStopHandle {
  if (__DEV__ && !cb) {
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }

  const warnInvalidSource = (s: unknown) => {
    warn(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`
    )
  }

  let getter: () => any
  let forceTrigger = false
  let isMultiSource = false

  if (isRef(source)) {
    // source可以是ref对象， 转换为函数：() => source.value，访问值收集依赖
    getter = () => (source as Ref).value
    forceTrigger = !!(source as Ref)._shallow
  } else if (isReactive(source)) {
    // source可以是Reactive对象， 转换为函数：() => source，使用深度监听(deep=true)，后面会使用traverse对对象的属性深度遍历收集依赖
    getter = () => source
    deep = true
  } else if (isArray(source)) {
    // source是多个对象
    isMultiSource = true
    forceTrigger = source.some(isReactive)
    // 转换为返回对象数组的函数，数组中每一个对象是每个监听的响应式对象
    getter = () =>
      source.map(s => {
        if (isRef(s)) { // Ref, 访问值收集依赖
          return s.value
        } else if (isReactive(s)) { // Reactive，深响应式对象，需要将对象的属性深度遍历(traverse)，目的是为了深度监听收集依赖
          return traverse(s) 
        } else if (isFunction(s)) { // Function，执行函数调用，收集依赖
          return callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER)
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    if (cb) {
      // getter with cb , 带回调函数的Function，和isRef、Reactive、Array统一起来，使用回调
      getter = () =>
        callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)
    } else {
      // no cb -> simple effect
      // 不带回调函数的Function，简单的封装为effect，effect默认的功能就是不带回调的Function
      getter = () => {
        if (instance && instance.isUnmounted) { // 如果是在组件中调用，组件卸载后不再响应
          return
        }
        if (cleanup) {
          cleanup()
        }
        return callWithAsyncErrorHandling(
          source,
          instance,
          ErrorCodes.WATCH_CALLBACK,
          [onInvalidate]
        )
      }
    }
  } else {
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  // 2.x array mutation watch compat
  if (__COMPAT__ && cb && !deep) {
    const baseGetter = getter
    getter = () => {
      const val = baseGetter()
      if (
        isArray(val) &&
        checkCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance)
      ) {
        traverse(val)
      }
      return val
    }
  }

  // 使用深度遍历时，需要对对象的属性深度遍历收集依赖
  if (cb && deep) {
    const baseGetter = getter
    getter = () => traverse(baseGetter())
  }

  let cleanup: () => void
  // 失效时回调，带回调(cb)的watch是第三个参数(前两个是newValue,oldValue)，不带回调的watch是第一个参数，
  // 一般用于回调函数中执行异步操作在effect失效时，需要将异步操作取消
  let onInvalidate: InvalidateCbRegistrator = (fn: () => void) => {
    cleanup = runner.options.onStop = () => {
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
    }
  }

  // in SSR there is no need to setup an actual effect, and it should be noop
  // unless it's eager
  if (__NODE_JS__ && isInSSRComponentSetup) {
    // we will also not call the invalidate callback (+ runner is not set up)
    onInvalidate = NOOP
    if (!cb) {
      getter()
    } else if (immediate) {
      callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
        getter(),
        undefined,
        onInvalidate
      ])
    }
    return NOOP
  }

  let oldValue = isMultiSource ? [] : INITIAL_WATCHER_VALUE
  const job: SchedulerJob = () => {
    // effect已结束
    if (!runner.active) {
      return
    }
    if (cb) { 
      // 由回调函数的需要获取oldValue、newValue，回调时三个参数(newValue,oldValue,onInvalidate)
      // 第三个参数onInvalidate是effect终止时的回调
      // watch(source, cb)
      const newValue = runner()
      if (
        deep ||
        forceTrigger ||
        (isMultiSource
          ? (newValue as any[]).some((v, i) =>
              hasChanged(v, (oldValue as any[])[i])
            )
          : hasChanged(newValue, oldValue)) ||
        (__COMPAT__ &&
          isArray(newValue) &&
          isCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance))
      ) {
        // cleanup before running cb again
        if (cleanup) {
          cleanup()
        }
        callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
          newValue,
          // pass undefined as the old value when it's changed for the first time
          oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
          onInvalidate
        ])
        oldValue = newValue
      }
    } else {
      // watchEffect， 不带回调的直接调用effect
      runner()
    }
  }

  // important: mark the job as a watcher callback so that scheduler knows
  // it is allowed to self-trigger (#1727)
  job.allowRecurse = !!cb

  // 定义effect的scheduler选项，修改effect回调时机，没有定义scheduler时默认会立即执行effect，见effect.ts中trigger源代码
  let scheduler: ReactiveEffectOptions['scheduler']
  // 执行时机
  if (flush === 'sync') { // sync：初始化时立即执行
    scheduler = job as any // the scheduler function gets called directly
  } else if (flush === 'post') { 
    // post: 组件渲染完成后再执行，默认情况下自定义watch是比vue组件渲染watch(即update函数)先执行的
    // 目的是避免多次更新，因为可能在watch改变响应对象导致update函数再次执行，可以修改flush为post。
    // 等待update执行完成后再执行，这样在回调中可以访问到dom
    scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
  } else {
    // default: 'pre', 默认值，在update函数执行之前执行，由于组件还未mounted，第一次回调执行时访问不到dom
    scheduler = () => {
      if (!instance || instance.isMounted) { // 不在组件中运行或者组件已mounted，需要在pre队列中执行
        queuePreFlushCb(job)
      } else {
        // with 'pre' option, the first call must happen before
        // the component is mounted so it is called synchronously.
        // 如果组件已经mounted，这时只能直接执行了
        job()
      }
    }
  }

  // 创建effect，默认是不会立即执行，由scheduler来接管执行时机
  const runner = effect(getter, {
    lazy: true,
    onTrack,
    onTrigger,
    scheduler
  })

  // 将watch内部使用的effect增加到组件实例的effects数组中，作用是在组件销毁时
  // 将effect结束掉(effect.active=false)
  recordInstanceBoundEffect(runner, instance)

  // initial run
  if (cb) {
    if (immediate) { // 带回调函数cb需要立即执行的，立即执行一次
      job()
    } else {
      oldValue = runner()
    }
  } else if (flush === 'post') {
    queuePostRenderEffect(runner, instance && instance.suspense)
  } else {
    runner()
  }

  // 返回effect停止函数
  return () => {
    stop(runner) // 停止effect
    if (instance) { // 如果是在vue组件中运行，还需要手动清理掉在recordInstanceBoundEffect中注册的instance.effects
      remove(instance.effects!, runner)
    }
  }
}

// this.$watch
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  value: WatchCallback | ObjectWatchOptionItem,
  options?: WatchOptions
): WatchStopHandle {
  const publicThis = this.proxy as any
  const getter = isString(source)
    ? source.includes('.')
      ? createPathGetter(publicThis, source)
      : () => publicThis[source]
    : source.bind(publicThis, publicThis)
  let cb
  if (isFunction(value)) {
    cb = value
  } else {
    cb = value.handler as Function
    options = value
  }
  return doWatch(getter, cb.bind(publicThis), options, this)
}

export function createPathGetter(ctx: any, path: string) {
  const segments = path.split('.')
  return () => {
    let cur = ctx
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]]
    }
    return cur
  }
}

// 深度遍历对象的每一个属性，用于依赖收集
function traverse(value: unknown, seen: Set<unknown> = new Set()) {
  if (
    !isObject(value) ||
    seen.has(value) ||
    (value as any)[ReactiveFlags.SKIP]
  ) {
    return value
  }
  seen.add(value)
  if (isRef(value)) {
    traverse(value.value, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v: any) => {
      traverse(v, seen)
    })
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse((value as any)[key], seen)
    }
  }
  return value
}
