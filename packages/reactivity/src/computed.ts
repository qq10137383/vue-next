import { effect, ReactiveEffect, trigger, track } from './effect'
import { TriggerOpTypes, TrackOpTypes } from './operations'
import { Ref } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

// computed get 方法
export type ComputedGetter<T> = (ctx?: any) => T
// computed set 方法
export type ComputedSetter<T> = (v: T) => void

// computed选项，可读可写的
export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

// ComputedRefImpl，基于effect实现的响应式计算属性
class ComputedRefImpl<T> {
  private _value!: T
  private _dirty = true //_value的值是否需要重新计算

  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true;
  public readonly [ReactiveFlags.IS_READONLY]: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean
  ) {
    // get方法包装为effect
    this.effect = effect(getter, {
      lazy: true, // lazy表示effect不需要立即执行
      scheduler: () => {
        // 由于定义了scheduler,计算属性某个依赖属性发生改变时不会再重新调用effect，而是调用scheduler，见effect.ts中trigger函数源码
        // 这样做的目的是为了延迟调用effect，因为直接调用effect是没有意义的，不能得到effect返回的计算值，只有当重新获取value时调用effect
        // 才能更新计算属性，scheduler中使用trigger触发组件视图更新，从而重新获取了value值
        if (!this._dirty) {
          this._dirty = true  // 标记计算值需要更新
          trigger(toRaw(this), TriggerOpTypes.SET, 'value') //触发组件视图需要更新
        }
      }
    })

    this[ReactiveFlags.IS_READONLY] = isReadonly // 只读标记
  } 

  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    const self = toRaw(this)
    // 初始化的时候由于effect是lazy类型，没有调用(getter)计算值，所以_dirty默认为true，表示需要计算
    // 所以第一次获取value的时候需要调用effect计算初始值，这时候会进行依赖收集，将this.effect加入到
    // 计算属性dep中，所以当依赖的属性发生变化时会调用scheduler回调函数标记计算值需要更新
    if (self._dirty) {
      self._value = this.effect() 
      self._dirty = false
    }
    // this.effect执行完之后，this.effect会从effectStack出栈，当前激活activeEffect变为vue组件的更新函数update
    // 此时再次调用收集依赖，是将vue组件的update函数增加到计算属性value的dep依赖中
    // 最终产生的效果就是：
    // 1、计算属性中任何一个属性发生变化导致ComputedRefImpl中this.effect发生回调，回调之后触发scheduler函数调用   
    // 2、scheduler函数调用之后将_dirty设置为true，表示_value需要重新计算，同时会触发trigger函数导致vue组件的update函数重新执行
    // 3、update函数是组件render函数的副作用函数，这时候会重新生成vNodes，生成过程中会重新获取计算属性ComputedRefImpl.value
    // 4、由于2中已经将_dirty设置为true，这时候会重新调用this.effect计算新值并重新收集this.effect和vue组件的update函数依赖。
    // 所以computed实际上是两个effect共同作用的结果，一个是computed内置的effect，负责计算属性变化时重新计算值
    // 另一个是组件的update函数，负责计算属性最终计算值发生变化时更新视图。
    track(self, TrackOpTypes.GET, 'value')
    return self._value
  }

  set value(newValue: T) {
    this._setter(newValue)
  }
}

// computed函数重载声明，如果参数是一个函数(ComputedGetter)则是只读的，如果是对象(WritableComputedOptions)则是可读可写的
export function computed<T>(getter: ComputedGetter<T>): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  // 如果是只读的，默认生成一个空的可写方法
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  // 创建Computed Ref  
  return new ComputedRefImpl(
    getter,
    setter,
    isFunction(getterOrOptions) || !getterOrOptions.set
  ) as any
}
