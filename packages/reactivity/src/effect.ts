import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  (): T
  _isEffect: true
  id: number
  active: boolean
  raw: () => T
  deps: Array<Dep>
  options: ReactiveEffectOptions
  allowRecurse: boolean
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  scheduler?: (job: ReactiveEffect) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
  /**
   * Indicates whether the job is allowed to recursively trigger itself when
   * managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  allowRecurse?: boolean
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

const effectStack: ReactiveEffect[] = []
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

// 副作用函数
export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  // fn如果已经是副作用函数，获取原始包装函数
  if (isEffect(fn)) {
    fn = fn.raw
  }
  // 创建副作用函数
  const effect = createReactiveEffect(fn, options)
  // 不是延迟执行，就立即执行副作用函数
  if (!options.lazy) {
    effect()
  }
  return effect
}

// 停止effect
export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    // 调用onStop回调函数，状态设置为非激活
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  // 对fn函数生成包装函数effect，作用是将回调函数放入全局
  // 的effectStack栈中，并设置当前激活的effect设置为自己，
  // 在track函数收集依赖时，会检查当前激活的effect，并将
  // effect加入到依赖链dep中，所以仅仅在effect包装的回调
  // 函数中访问数据，才会触发track的依赖收集，如： 
  // const data = reactive({
  //     name: "hello"
  // });
  // watchEffect(() => {
  //     console.log(data.name);
  // });
  // data.name = "world";
  //
  // watchEffect会调用createReactiveEffect生成包装函数effect 
  // 生成后会立即执行一次(flush默认为pre，在mounted前会执行一次，
  // 在schedule队列中执行)
  // 执行后获取data.name，由于data是proxy后的数据，在get时会执行
  // track函数检查当前激活effect，正好是watchEffect包装的这个effect
  // 这个effect会进去data数据name属性的依赖链，当设置data.name时
  // 会触发trigger函数，此时依赖链的所有effect会依次调用，回调函数
  // 会重新调用，达到响应式效果
  // console.log会执行两次，第一次是watchEffect返回之后，在schedule
  // 队列中执行一次，此时会收集依赖。
  // 第二次是设置data.name时会重新调用响应数据修改。
  const effect = function reactiveEffect(): unknown {
    // 已经关闭的effect不再响应，用来stop effect
    if (!effect.active) {
      return fn()
    }
    // 全局effectStack中加入effect，并设置为当前激活
    if (!effectStack.includes(effect)) {
      // 先清空清理effect中的deps
      cleanup(effect)
      try {
        enableTracking()
        effectStack.push(effect)
        activeEffect = effect
        return fn()
      } finally {
        effectStack.pop()
        resetTracking()
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  effect.id = uid++
  effect.allowRecurse = !!options.allowRecurse
  effect._isEffect = true // 已经增强
  effect.active = true // 激活状态，用来开关effect
  effect.raw = fn  // 包装的原始函数
  effect.deps = []  // 初始化effect的依赖链，形成双向关系，dep中有effect，effect中有dep
  effect.options = options // effect选项参数
  return effect
}

// 清理effect中的deps
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true
const trackStack: boolean[] = []

// 暂停依赖收集
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

// 开始依赖收集
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

// 恢复到上一次的依赖收集状态
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

// 收集副作用依赖
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 判断是否在effect中执行，不在effect中执行无法进行依赖收集
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  // targetMap的结构:
  // targetMap -> WeakMap
  // targetMap[key1] -> Map ，key1表示某一个代理对象，Map表示某一对象的依赖链集合
  // targetMap[key1][key2] -> Set，key2表示代理对象的某一属性，Set表示某一对象某一属性的依赖链(Effect列表)
  // 如:
  // const item = {
  //   name: "hello",
  //   age: 25
  // }
  // const data = reactive(item);
  // watchEffect(() => {
  //    console.log(data.name+data.age);
  // });
  // 结构如下:
  // targetMap.get(item) -> Map，item对象的依赖链集合depsMap={name: dep, age: dep}
  // targetMap.get(item).get('name') -> Set ，item对象name属性的依赖链集合dep=Set<effect>，Set中的元素为watchEffect包装的effect
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  let dep = depsMap.get(key)
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    // 将dep也添加到effect的依赖链里，相互引用
    activeEffect.deps.push(dep)
    // 仅dev模式收集依赖时会回调options.onTrack函数
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

// 触发副作用
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 获取对象->属性的依赖链，依次调用effect方法。
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  // effect调用链
  const effects = new Set<ReactiveEffect>()
  // 增加effect到调用链
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        if (effect !== activeEffect || effect.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }

  // 属性将会被清除，将所有依赖此属性的effect全部调用一遍
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) {
    // 数组长度改变，将依赖长度属性或者数组新长度以外的值的effect全部调用一遍
    // 意思就是如果长度改变，依赖长度属性的effect调用，如果长度减小，数组变短，依赖已被删除元素的effect调用
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 一般情况，依赖该属性的effect全部调用
    if (key !== void 0) {
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    // 迭代器iterator处理
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const run = (effect: ReactiveEffect) => {
    // 仅dev模式会回调options.onTrigger
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    // 如果定义了options.scheduler就调用scheduler，否则调用effect
    // computed中利用此功能实现了effect的计划调用，调用scheduler设置计算属性需要重新计算
    // 调用trigger触发组件视图更新，重新获取计算属性，在调用计算属性的effect
    // watch中也使用此功能，在不同时机pre、post、sync中调用effect
    if (effect.options.scheduler) {
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }

  // 依次执行effect
  effects.forEach(run)
}
