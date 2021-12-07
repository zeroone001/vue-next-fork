import { isTracking, trackEffects, triggerEffects } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { isArray, hasChanged } from '@vue/shared'
import { isProxy, toRaw, isReactive, toReactive } from './reactive'
import type { ShallowReactiveMarker } from './reactive'
import { CollectionTypes } from './collectionHandlers'
import { createDep, Dep } from './dep'

/* 
  ref 的 创建使用了类
*/
declare const RefSymbol: unique symbol

export interface Ref<T = any> {
  value: T
  /**
   * Type differentiator only.
   * We need this to be in public d.ts but don't want it to show up in IDE
   * autocomplete, so we use a private Symbol instead.
   */
  [RefSymbol]: true
  /**
   * @internal
   */
  _shallow?: boolean
}

type RefBase<T> = {
  dep?: Dep
  value: T
}

/* 
  ref 的 依赖收集
*/
export function trackRefValue(ref: RefBase<any>) {
  if (isTracking()) {
    ref = toRaw(ref)
    /* 之前如果没有添加dep, 那么create */
    if (!ref.dep) {
      /* 
      创建了一个 Set
      主要是对基础类型使用了 ref.dep 这个存依赖
       */
      ref.dep = createDep()
    }
    if (__DEV__) {
      trackEffects(ref.dep, {
        target: ref,
        type: TrackOpTypes.GET,
        key: 'value'
      })
    } else {
      trackEffects(ref.dep)
    }
  }
}

/* 触发依赖， 触发更新视图 */
export function triggerRefValue(ref: RefBase<any>, newVal?: any) {
  ref = toRaw(ref)
  if (ref.dep) {
    /* 存在dep 属性，值为Set */
    if (__DEV__) {
      triggerEffects(ref.dep, {
        target: ref,
        type: TriggerOpTypes.SET,
        key: 'value',
        newValue: newVal
      })
    } else {
      triggerEffects(ref.dep)
    }
  }
}

export function isRef<T>(r: Ref<T> | unknown): r is Ref<T>
export function isRef(r: any): r is Ref {
  return Boolean(r && r.__v_isRef === true)
}

export function ref<T extends object>(
  value: T
): [T] extends [Ref] ? T : Ref<UnwrapRef<T>>
export function ref<T>(value: T): Ref<UnwrapRef<T>>
export function ref<T = any>(): Ref<T | undefined>
/* 
  在这里定义的ref方法
*/
export function ref(value?: unknown) {
  return createRef(value, false)
}

declare const ShallowRefMarker: unique symbol

type ShallowRef<T = any> = Ref<T> & { [ShallowRefMarker]?: true }

export function shallowRef<T extends object>(
  value: T
): T extends Ref ? T : ShallowRef<T>
export function shallowRef<T>(value: T): ShallowRef<T>
export function shallowRef<T = any>(): ShallowRef<T | undefined>
export function shallowRef(value?: unknown) {
  return createRef(value, true)
}
/* 
  createRef
  主要看 类 RefImpl
*/
function createRef(rawValue: unknown, shallow: boolean) {
  if (isRef(rawValue)) {
    return rawValue
  }
  return new RefImpl(rawValue, shallow)
}
/* 
  创建ref的类
  使用类的get和set来监听属性value是否有变化
*/
class RefImpl<T> {
  private _value: T
  private _rawValue: T

  public dep?: Dep = undefined
  /* 用于 isRef 函数的判断 */
  public readonly __v_isRef = true

  constructor(value: T, public readonly _shallow: boolean) {
    /* 
      接受两个参数，一个是 rawValue原始值，一个是shallow，是否是浅代理
      export const toReactive = <T extends unknown>(value: T): T =>
      isObject(value) ? reactive(value) : value

      export function toRaw<T>(observed: T): T {
      const raw = observed && (observed as Target)[ReactiveFlags.RAW]
      return raw ? toRaw(raw) : observed
    }
    */
    this._rawValue = _shallow ? value : toRaw(value)
    /* 
    代表ref() 里面也可以传对象 如果不是浅观察的话，就转化为响应式对象
    toReactive 函数里面判断了是否是对象，如果不是对象，直接返回value
     */
    this._value = _shallow ? value : toReactive(value)
  }

  get value() {
    /* 依赖收集
      注意，这里把RefImpl实例传进去了，
      也就是说，把dep 放在了 RefImpl 上面
    */
    trackRefValue(this)
    /* 直接返回value */
    return this._value
  }

  set value(newVal) {
    newVal = this._shallow ? newVal : toRaw(newVal)
    if (hasChanged(newVal, this._rawValue)) {
      /* 判断新旧两个值是否有变化 */
      this._rawValue = newVal
      this._value = this._shallow ? newVal : toReactive(newVal)
      /* 触发依赖 */
      triggerRefValue(this, newVal)
    }
  }
}

/* 
  这个比较少用，因为是跟shallowRef 一起用的
*/
export function triggerRef(ref: Ref) {
  triggerRefValue(ref, __DEV__ ? ref.value : void 0)
}

export function unref<T>(ref: T | Ref<T>): T {
  return isRef(ref) ? (ref.value as any) : ref
}

const shallowUnwrapHandlers: ProxyHandler<any> = {
  get: (target, key, receiver) => unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key]
    if (isRef(oldValue) && !isRef(value)) {
      oldValue.value = value
      return true
    } else {
      return Reflect.set(target, key, value, receiver)
    }
  }
}
/* 
  如果isReactive的话，直接返回
  否则 Proxy
*/
export function proxyRefs<T extends object>(
  objectWithRefs: T
): ShallowUnwrapRef<T> {
  return isReactive(objectWithRefs)
    ? objectWithRefs
    : new Proxy(objectWithRefs, shallowUnwrapHandlers)
}

type CustomRefFactory<T> = (
  track: () => void,
  trigger: () => void
) => {
  get: () => T
  set: (value: T) => void
}

class CustomRefImpl<T> {
  public dep?: Dep = undefined

  private readonly _get: ReturnType<CustomRefFactory<T>>['get']
  private readonly _set: ReturnType<CustomRefFactory<T>>['set']

  public readonly __v_isRef = true

  constructor(factory: CustomRefFactory<T>) {
    /* 
      接收一个工厂函数 factory
      解构工厂函数里面的get set
    */
    const { get, set } = factory(
      () => trackRefValue(this),
      () => triggerRefValue(this)
    )
    this._get = get
    this._set = set
  }

  get value() {
    return this._get()
  }

  set value(newVal) {
    this._set(newVal)
  }
}

/* 
  创建一个自定义的ref
*/
export function customRef<T>(factory: CustomRefFactory<T>): Ref<T> {
  return new CustomRefImpl(factory) as any
}

export type ToRefs<T = any> = {
  // #2687: somehow using ToRef<T[K]> here turns the resulting type into
  // a union of multiple Ref<*> types instead of a single Ref<* | *> type.
  [K in keyof T]: T[K] extends Ref ? T[K] : Ref<UnwrapRef<T[K]>>
}
/* 
  toRefs() 函数就是超级常用的函数了
  将响应式对象，转换为普通对象，并且，每个属性都是ref
*/
export function toRefs<T extends object>(object: T): ToRefs<T> {
  /* 如果object不是 Proxy，报警告 */
  if (__DEV__ && !isProxy(object)) {
    console.warn(`toRefs() expects a reactive object but received a plain one.`)
  }
  /* 如果是数组的话，创建一个新的数组，用于返回 */
  const ret: any = isArray(object) ? new Array(object.length) : {}
  for (const key in object) {
    /* 每一个属性都转成ref */
    ret[key] = toRef(object, key)
  }
  return ret
}

class ObjectRefImpl<T extends object, K extends keyof T> {
  public readonly __v_isRef = true

  constructor(private readonly _object: T, private readonly _key: K) {}

  get value() {
    return this._object[this._key]
  }

  set value(newVal) {
    this._object[this._key] = newVal
  }
}

export type ToRef<T> = [T] extends [Ref] ? T : Ref<T>

/* 
    这个函数是常用的
    目的是为了给响应式对象上的属性，创建一个ref
*/
export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K
): ToRef<T[K]> {
  /* object 和 key 都是必填 */
  const val = object[key]
  /* 如果val 已经是ref 类型，直接返回； 否则，使用类 处理 */
  return isRef(val) ? val : (new ObjectRefImpl(object, key) as any)
}

// corner case when use narrows type
// Ex. type RelativePath = string & { __brand: unknown }
// RelativePath extends object -> true
type BaseTypes = string | number | boolean

/**
 * This is a special exported interface for other packages to declare
 * additional types that should bail out for ref unwrapping. For example
 * \@vue/runtime-dom can declare it like so in its d.ts:
 *
 * ``` ts
 * declare module '@vue/reactivity' {
 *   export interface RefUnwrapBailTypes {
 *     runtimeDOMBailTypes: Node | Window
 *   }
 * }
 * ```
 *
 * Note that api-extractor somehow refuses to include `declare module`
 * augmentations in its generated d.ts, so we have to manually append them
 * to the final generated d.ts in our build process.
 */
export interface RefUnwrapBailTypes {}

export type ShallowUnwrapRef<T> = {
  [K in keyof T]: T[K] extends Ref<infer V>
    ? V
    : // if `V` is `unknown` that means it does not extend `Ref` and is undefined
    T[K] extends Ref<infer V> | undefined
    ? unknown extends V
      ? undefined
      : V | undefined
    : T[K]
}

export type UnwrapRef<T> = T extends ShallowRef<infer V>
  ? V
  : T extends Ref<infer V>
  ? UnwrapRefSimple<V>
  : UnwrapRefSimple<T>

export type UnwrapRefSimple<T> = T extends
  | Function
  | CollectionTypes
  | BaseTypes
  | Ref
  | RefUnwrapBailTypes[keyof RefUnwrapBailTypes]
  ? T
  : T extends Array<any>
  ? { [K in keyof T]: UnwrapRefSimple<T[K]> }
  : T extends object & { [ShallowReactiveMarker]?: never }
  ? {
      [P in keyof T]: P extends symbol ? T[P] : UnwrapRef<T[P]>
    }
  : T
