import {
  ComponentInternalInstance,
  Data,
  isStatefulComponent
} from './component'
import { nextTick, queueJob } from './scheduler'
import { instanceWatch, WatchOptions, WatchStopHandle } from './apiWatch'
import {
  EMPTY_OBJ,
  hasOwn,
  isGloballyWhitelisted,
  NOOP,
  extend,
  isString,
  isFunction
} from '@vue/shared'
import {
  ReactiveEffect,
  toRaw,
  shallowReadonly,
  track,
  TrackOpTypes,
  ShallowUnwrapRef,
  UnwrapNestedRefs
} from '@vue/reactivity'
import {
  ExtractComputedReturns,
  ComponentOptionsBase,
  ComputedOptions,
  MethodOptions,
  ComponentOptionsMixin,
  OptionTypesType,
  OptionTypesKeys,
  resolveMergedOptions,
  shouldCacheAccess,
  MergedComponentOptionsOverride
} from './componentOptions'
import { EmitsOptions, EmitFn } from './componentEmits'
import { Slots } from './componentSlots'
import { markAttrsAccessed } from './componentRenderUtils'
import { currentRenderingInstance } from './componentRenderContext'
import { warn } from './warning'
import { UnionToIntersection } from './helpers/typeUtils'
import { installCompatInstanceProperties } from './compat/instance'

/**
 * Custom properties added to component instances in any way and can be accessed through `this`
 *
 * @example
 * Here is an example of adding a property `$router` to every component instance:
 * ```ts
 * import { createApp } from 'vue'
 * import { Router, createRouter } from 'vue-router'
 *
 * declare module '@vue/runtime-core' {
 *   interface ComponentCustomProperties {
 *     $router: Router
 *   }
 * }
 *
 * // effectively adding the router to every component instance
 * const app = createApp({})
 * const router = createRouter()
 * app.config.globalProperties.$router = router
 *
 * const vm = app.mount('#app')
 * // we can access the router from the instance
 * vm.$router.push('/')
 * ```
 */
export interface ComponentCustomProperties {}

type IsDefaultMixinComponent<T> = T extends ComponentOptionsMixin
  ? ComponentOptionsMixin extends T ? true : false
  : false

type MixinToOptionTypes<T> = T extends ComponentOptionsBase<
  infer P,
  infer B,
  infer D,
  infer C,
  infer M,
  infer Mixin,
  infer Extends,
  any,
  any,
  infer Defaults
>
  ? OptionTypesType<P & {}, B & {}, D & {}, C & {}, M & {}, Defaults & {}> &
      IntersectionMixin<Mixin> &
      IntersectionMixin<Extends>
  : never

// ExtractMixin(map type) is used to resolve circularly references
type ExtractMixin<T> = {
  Mixin: MixinToOptionTypes<T>
}[T extends ComponentOptionsMixin ? 'Mixin' : never]

type IntersectionMixin<T> = IsDefaultMixinComponent<T> extends true
  ? OptionTypesType<{}, {}, {}, {}, {}>
  : UnionToIntersection<ExtractMixin<T>>

type UnwrapMixinsType<
  T,
  Type extends OptionTypesKeys
> = T extends OptionTypesType ? T[Type] : never

type EnsureNonVoid<T> = T extends void ? {} : T

export type ComponentPublicInstanceConstructor<
  T extends ComponentPublicInstance<
    Props,
    RawBindings,
    D,
    C,
    M
  > = ComponentPublicInstance<any>,
  Props = any,
  RawBindings = any,
  D = any,
  C extends ComputedOptions = ComputedOptions,
  M extends MethodOptions = MethodOptions
> = {
  __isFragment?: never
  __isTeleport?: never
  __isSuspense?: never
  new (...args: any[]): T
}

export type CreateComponentPublicInstance<
  P = {},
  B = {},
  D = {},
  C extends ComputedOptions = {},
  M extends MethodOptions = {},
  Mixin extends ComponentOptionsMixin = ComponentOptionsMixin,
  Extends extends ComponentOptionsMixin = ComponentOptionsMixin,
  E extends EmitsOptions = {},
  PublicProps = P,
  Defaults = {},
  MakeDefaultsOptional extends boolean = false,
  PublicMixin = IntersectionMixin<Mixin> & IntersectionMixin<Extends>,
  PublicP = UnwrapMixinsType<PublicMixin, 'P'> & EnsureNonVoid<P>,
  PublicB = UnwrapMixinsType<PublicMixin, 'B'> & EnsureNonVoid<B>,
  PublicD = UnwrapMixinsType<PublicMixin, 'D'> & EnsureNonVoid<D>,
  PublicC extends ComputedOptions = UnwrapMixinsType<PublicMixin, 'C'> &
    EnsureNonVoid<C>,
  PublicM extends MethodOptions = UnwrapMixinsType<PublicMixin, 'M'> &
    EnsureNonVoid<M>,
  PublicDefaults = UnwrapMixinsType<PublicMixin, 'Defaults'> &
    EnsureNonVoid<Defaults>
> = ComponentPublicInstance<
  PublicP,
  PublicB,
  PublicD,
  PublicC,
  PublicM,
  E,
  PublicProps,
  PublicDefaults,
  MakeDefaultsOptional,
  ComponentOptionsBase<P, B, D, C, M, Mixin, Extends, E, string, Defaults>
>

// public properties exposed on the proxy, which is used as the render context
// in templates (as `this` in the render option)
export type ComponentPublicInstance<
  P = {}, // props type extracted from props option
  B = {}, // raw bindings returned from setup()
  D = {}, // return from data()
  C extends ComputedOptions = {},
  M extends MethodOptions = {},
  E extends EmitsOptions = {},
  PublicProps = P,
  Defaults = {},
  MakeDefaultsOptional extends boolean = false,
  Options = ComponentOptionsBase<any, any, any, any, any, any, any, any, any>
> = {
  $: ComponentInternalInstance
  $data: D
  $props: MakeDefaultsOptional extends true
    ? Partial<Defaults> & Omit<P & PublicProps, keyof Defaults>
    : P & PublicProps
  $attrs: Data
  $refs: Data
  $slots: Slots
  $root: ComponentPublicInstance | null
  $parent: ComponentPublicInstance | null
  $emit: EmitFn<E>
  $el: any
  $options: Options & MergedComponentOptionsOverride
  $forceUpdate: ReactiveEffect
  $nextTick: typeof nextTick
  $watch(
    source: string | Function,
    cb: Function,
    options?: WatchOptions
  ): WatchStopHandle
} & P &
  ShallowUnwrapRef<B> &
  UnwrapNestedRefs<D> &
  ExtractComputedReturns<C> &
  M &
  ComponentCustomProperties

export type PublicPropertiesMap = Record<
  string,
  (i: ComponentInternalInstance) => any
>

/**
 * #2437 In Vue 3, functional components do not have a public instance proxy but
 * they exist in the internal parent chain. For code that relies on traversing
 * public $parent chains, skip functional ones and go to the parent instead.
 */
const getPublicInstance = (
  i: ComponentInternalInstance | null
): ComponentPublicInstance | ComponentInternalInstance['exposed'] | null => {
  if (!i) return null
  if (isStatefulComponent(i)) return i.exposed ? i.exposed : i.proxy
  return getPublicInstance(i.parent)
}

const publicPropertiesMap: PublicPropertiesMap = extend(Object.create(null), {
  $: i => i,
  $el: i => i.vnode.el,
  $data: i => i.data,
  $props: i => (__DEV__ ? shallowReadonly(i.props) : i.props),
  $attrs: i => (__DEV__ ? shallowReadonly(i.attrs) : i.attrs),
  $slots: i => (__DEV__ ? shallowReadonly(i.slots) : i.slots),
  $refs: i => (__DEV__ ? shallowReadonly(i.refs) : i.refs),
  $parent: i => getPublicInstance(i.parent),
  $root: i => getPublicInstance(i.root),
  $emit: i => i.emit,
  $options: i => (__FEATURE_OPTIONS_API__ ? resolveMergedOptions(i) : i.type),
  $forceUpdate: i => () => queueJob(i.update),
  $nextTick: i => nextTick.bind(i.proxy!),
  $watch: i => (__FEATURE_OPTIONS_API__ ? instanceWatch.bind(i) : NOOP)
} as PublicPropertiesMap)

if (__COMPAT__) {
  installCompatInstanceProperties(publicPropertiesMap)
}

const enum AccessTypes {
  SETUP,
  DATA,
  PROPS,
  CONTEXT,
  OTHER
}

export interface ComponentRenderContext {
  [key: string]: any
  _: ComponentInternalInstance
}

// 组件外部实例(内部实例代理)，处理器
export const PublicInstanceProxyHandlers: ProxyHandler<any> = {
  get({ _: instance }: ComponentRenderContext, key: string) {
    const {
      ctx,
      setupState,
      data,
      props,
      accessCache,
      type,
      appContext
    } = instance

    // for internal formatters to know that this is a Vue instance
    // __isVue属性始终为true
    if (__DEV__ && key === '__isVue') {
      return true
    }

    // data / props / ctx
    // This getter gets called for every property access on the render context
    // during render and is a major hotspot. The most expensive part of this
    // is the multiple hasOwn() calls. It's much faster to do a simple property
    // access on a plain object, so we use an accessCache object (with null
    // prototype) to memoize what access type a key corresponds to.
    let normalizedProps
    // $开头的属性是内部实例属性，只读且不可枚举，如$,$options,$attrs,$data,$props等
    // 其他的属性为外部属性
    if (key[0] !== '$') {
      // 已有属性值位置(setupState、data、props、ctx等)缓存信息，获取属性值，加快属性检索速度
      const n = accessCache![key]
      if (n !== undefined) {
        switch (n) {
          case AccessTypes.SETUP:
            return setupState[key]
          case AccessTypes.DATA:
            return data[key]
          case AccessTypes.CONTEXT:
            return ctx[key]
          case AccessTypes.PROPS:
            return props![key]
          // default: just fallthrough
        }
      } else if (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) {
        // 值在setup方法返回的对象中，从setupState中获取，并设置位置缓存
        accessCache![key] = AccessTypes.SETUP
        return setupState[key]
      } else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
        // 值在data方法返回的对象中，从data中获取，并设置位置缓存
        accessCache![key] = AccessTypes.DATA
        return data[key]
      } else if (
        // only cache other properties when instance has declared (thus stable)
        // props
        (normalizedProps = instance.propsOptions[0]) &&
        hasOwn(normalizedProps, key)
      ) {
        // 值在属性props中，从属性中获取，并设置位置缓存
        accessCache![key] = AccessTypes.PROPS
        return props![key]
      } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
        // 值在ctx中，从ctx中获取，并设置位置缓存
        accessCache![key] = AccessTypes.CONTEXT
        return ctx[key]
      } else if (!__FEATURE_OPTIONS_API__ || shouldCacheAccess) {
        accessCache![key] = AccessTypes.OTHER
      }
    }

    // 这里直接调用方法从instance的获取值，从而绕过ctx通过defineObject定义的属性
    const publicGetter = publicPropertiesMap[key]
    let cssModule, globalProperties
    // public $xxx properties
    if (publicGetter) {
      // 获取$attrs属性时要进行依赖收集
      if (key === '$attrs') {
        track(instance, TrackOpTypes.GET, key)
        __DEV__ && markAttrsAccessed()
      }
      return publicGetter(instance)
    } else if (
      // css module (injected by vue-loader)
      (cssModule = type.__cssModules) &&
      (cssModule = cssModule[key])
    ) {
      return cssModule
    } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
      // user may set custom properties to `this` that start with `$`
      accessCache![key] = AccessTypes.CONTEXT
      return ctx[key]
    } else if (
      // global properties
      // 从全局属性中获取
      ((globalProperties = appContext.config.globalProperties),
      hasOwn(globalProperties, key))
    ) {
      if (__COMPAT__) {
        const desc = Object.getOwnPropertyDescriptor(globalProperties, key)!
        if (desc.get) {
          // 获取通过get定义属性
          return desc.get.call(instance.proxy)
        } else {
          const val = globalProperties[key]
          return isFunction(val) ? val.bind(instance.proxy) : val
        }
      } else {
        return globalProperties[key]
      }
    } else if (
      __DEV__ &&
      currentRenderingInstance &&
      (!isString(key) ||
        // #1091 avoid internal isRef/isVNode checks on component instance leading
        // to infinite warning loop
        key.indexOf('__v') !== 0)
    ) {
      if (
        data !== EMPTY_OBJ &&
        (key[0] === '$' || key[0] === '_') &&
        hasOwn(data, key)
      ) {
        warn(
          `Property ${JSON.stringify(
            key
          )} must be accessed via $data because it starts with a reserved ` +
            `character ("$" or "_") and is not proxied on the render context.`
        )
      } else if (instance === currentRenderingInstance) {
        warn(
          `Property ${JSON.stringify(key)} was accessed during render ` +
            `but is not defined on instance.`
        )
      }
    }
  },

  set(
    { _: instance }: ComponentRenderContext,
    key: string,
    value: any
  ): boolean {
    const { data, setupState, ctx } = instance
    if (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) {
      // 设置setupState
      setupState[key] = value
    } else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
      // 设置data
      data[key] = value
    } else if (hasOwn(instance.props, key)) { /**属性是单向传值的，不能被设值 */
      __DEV__ &&
        warn(
          `Attempting to mutate prop "${key}". Props are readonly.`,
          instance
        )
      return false
    }
    if (key[0] === '$' && key.slice(1) in instance) {
      __DEV__ &&
        warn(
          `Attempting to mutate public property "${key}". ` +
            `Properties starting with $ are reserved and readonly.`,
          instance
        )
      return false
    } else {
      // 设置全局属性
      if (__DEV__ && key in instance.appContext.config.globalProperties) {
        Object.defineProperty(ctx, key, {
          enumerable: true,
          configurable: true,
          value
        })
      } else {
        ctx[key] = value
      }
    }
    return true
  },

  has(
    {
      _: { data, setupState, accessCache, ctx, appContext, propsOptions }
    }: ComponentRenderContext,
    key: string
  ) {
    let normalizedProps
    return (
      accessCache![key] !== undefined ||
      (data !== EMPTY_OBJ && hasOwn(data, key)) ||
      (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) ||
      ((normalizedProps = propsOptions[0]) && hasOwn(normalizedProps, key)) ||
      hasOwn(ctx, key) ||
      hasOwn(publicPropertiesMap, key) ||
      hasOwn(appContext.config.globalProperties, key)
    )
  }
}

if (__DEV__ && !__TEST__) {
  PublicInstanceProxyHandlers.ownKeys = (target: ComponentRenderContext) => {
    warn(
      `Avoid app logic that relies on enumerating keys on a component instance. ` +
        `The keys will be empty in production mode to avoid performance overhead.`
    )
    return Reflect.ownKeys(target)
  }
}

export const RuntimeCompiledPublicInstanceProxyHandlers = extend(
  {},
  PublicInstanceProxyHandlers,
  {
    get(target: ComponentRenderContext, key: string) {
      // fast path for unscopables when using `with` block
      if ((key as any) === Symbol.unscopables) {
        return
      }
      return PublicInstanceProxyHandlers.get!(target, key, target)
    },
    has(_: ComponentRenderContext, key: string) {
      const has = key[0] !== '_' && !isGloballyWhitelisted(key)
      if (__DEV__ && !has && PublicInstanceProxyHandlers.has!(_, key)) {
        warn(
          `Property ${JSON.stringify(
            key
          )} should not start with _ which is a reserved prefix for Vue internals.`
        )
      }
      return has
    }
  }
)

// In dev mode, the proxy target exposes the same properties as seen on `this`
// for easier console inspection. In prod mode it will be an empty object so
// these properties definitions can be skipped.
// 生成组件内部公共属性，$，$el，$props，$data，$attrs等等，这些属性都是不可枚举的
// (enumerable: false)，只读的(没有set方法)，仅仅是内部使用
export function createRenderContext(instance: ComponentInternalInstance) {
  const target: Record<string, any> = {}

  // expose internal instance for proxy handlers
  Object.defineProperty(target, `_`, {
    configurable: true,
    enumerable: false,
    get: () => instance
  })

  // expose public properties
  // instance中属性映射关系：
  // $: i => i,
  // $el: i => i.vnode.el,
  // $data: i => i.data,
  // $props: i => (__DEV__ ? shallowReadonly(i.props) : i.props),
  // $attrs: i => (__DEV__ ? shallowReadonly(i.attrs) : i.attrs),
  // $slots: i => (__DEV__ ? shallowReadonly(i.slots) : i.slots),
  // $refs: i => (__DEV__ ? shallowReadonly(i.refs) : i.refs),
  // $parent: i => getPublicInstance(i.parent),
  // $root: i => getPublicInstance(i.root),
  // $emit: i => i.emit,
  // $options: i => (__FEATURE_OPTIONS_API__ ? resolveMergedOptions(i) : i.type),
  // $forceUpdate: i => () => queueJob(i.update),
  // $nextTick: i => nextTick.bind(i.proxy!),
  // $watch: i => (__FEATURE_OPTIONS_API__ ? instanceWatch.bind(i) : NOOP)
  Object.keys(publicPropertiesMap).forEach(key => {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      get: () => publicPropertiesMap[key](instance),
      // intercepted by the proxy so no need for implementation,
      // but needed to prevent set errors
      set: NOOP
    })
  })

  return target as ComponentRenderContext
}

// dev only
export function exposePropsOnRenderContext(
  instance: ComponentInternalInstance
) {
  const {
    ctx,
    propsOptions: [propsOptions]
  } = instance
  if (propsOptions) {
    Object.keys(propsOptions).forEach(key => {
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: () => instance.props[key],
        set: NOOP
      })
    })
  }
}

// dev only
export function exposeSetupStateOnRenderContext(
  instance: ComponentInternalInstance
) {
  const { ctx, setupState } = instance
  Object.keys(toRaw(setupState)).forEach(key => {
    if (key[0] === '$' || key[0] === '_') {
      warn(
        `setup() return property ${JSON.stringify(
          key
        )} should not start with "$" or "_" ` +
          `which are reserved prefixes for Vue internals.`
      )
      return
    }
    Object.defineProperty(ctx, key, {
      enumerable: true,
      configurable: true,
      get: () => setupState[key],
      set: NOOP
    })
  })
}
