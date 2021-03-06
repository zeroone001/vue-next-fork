import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)
/* 
  get, set 都是很重要的公共函数，
  是Proxy的handlers
*/
const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

/* 
  这个函数对数组来说很重要
  这是get 中的处理数组的函数
  目的就是返回一个对象，并且定义了原生的key, 也就是重写了数组里的原生方法
  https://juejin.cn/post/6844904056356339720
  instrumentations： 中文，仪器
*/
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  /* includes，indexOf， lastIndexOf 这三个方法是不会被监听的  */
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 得到对象的原生数据然后执行原生的方法
      /* 
        为了做一些不想被监听的事情，目的是为了提升性能
      */
      const arr = toRaw(this) as any
      for (let i = 0, l = this.length; i < l; i++) {
        // 收集依赖
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      /* 执行原生的方法，获取结果res */
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        /* 如果没获取到值的话，再把args toRaw，再执行一遍方法 */
        /* 防止传入的值，也是响应式对象 */
        return arr[key](...args.map(toRaw))
      } else {
        /* 获取到了，就直接返回 */
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  /* 
    处理导致数组本身改变的api
    sort 和 reverse 没有了
  */
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      /* 开启依赖收集 */
      pauseTracking()
      // 执行原生的方法
      const res = (toRaw(this) as any)[key].apply(this, args)
      /* 关闭依赖收集 */
      resetTracking()
      return res
    }
  })
  return instrumentations
}
/* 
  createGetter 接受两个参数
  1，是否只读，2， 浅代理
*/
function createGetter(isReadonly = false, shallow = false) {
  /*  */
  return function get(target: Target, key: string | symbol, receiver: object) {
    /* 重点 */
    if (key === ReactiveFlags.IS_REACTIVE) {
      /* 访问属性 __v_isReactive */
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      /* 
       访问属性  __v_isReadonly
      */
      return isReadonly
    } else if (
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      /* toRaw() 函数， 执行到这里了 */
      return target
    }

    /* 判断是不是数组 */
    const targetIsArray = isArray(target)

    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      /* 
        数组的话，直接返回了
        这里也是做了依赖收集的
        在这个里面 arrayInstrumentations
       */
      return Reflect.get(arrayInstrumentations, key, receiver)
    }
    /* 
      获取get返回值
    */
    const res = Reflect.get(target, key, receiver)

    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }
    /* 
      // 问题：为什么是 readonly 的时候不做依赖收集呢
    // readonly 的话，是不可以被 set 的， 那不可以被 set 就意味着不会触发 trigger
    // 所有就没有收集依赖的必要了
    // 只读的数据回改变，也就不需要收集依赖
    */
    if (!isReadonly) {
      /* 
      // 在触发 get 的时候进行依赖收集 
      */
      track(target, TrackOpTypes.GET, key)
    }
    /* shallow 的话，只劫持一层 */
    if (shallow) {
      /* 直接return */
      return res
    }
    /* 如果是ref 类型 */
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    if (isObject(res)) {
      /* 
        如果是对象的话
        再执行reactive代理，每一层都代理
        如果是只读的话，就直接返回 readonly后的
        注意： 这里是延迟代理
        这里注意，只会代理第一层的数据，只有在读取数据触发get 才会把嵌套的对象转化成响应式对象
        Vue2里面，是直接递归把所有的数据全部转化成响应式对象
       */
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}


const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)
/* 
  这个也是很重要的函数 setter函数
*/
function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    /* 旧值 */
    let oldValue = (target as any)[key]

    if (!shallow) {
      /* 不是浅代理 */
      /* 获取本身的值，不是响应式的值 */
      value = toRaw(value)
      oldValue = toRaw(oldValue)
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        /* 
          不是数组，并且，旧值是ref, 新值不是ref，执行下面的操作
        */
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }
    /* 判断要设置的key 存不存在 */
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    /* 设置新值 */
    const result = Reflect.set(target, key, value, receiver)

    // receiver : Proxy或者继承Proxy的对象
    /*  
      确保依赖的数据源是同一个对象
      if 用于判断不是继承自proxy的对象，也就是说，如果是原型链中的东西，就不要触发
    */
    if (target === toRaw(receiver)) {
      /* 触发依赖 */
      if (!hadKey) {
        /* 新增数据，不存在key的话，走add */
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        /* 存在数据，已经有 key 的话 ，直接set */
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

function ownKeys(target: object): (string | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}
/* 
  这是最基础的 handlers
*/
export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}
/* 
  这是readonly 的handlers

*/
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    /* 在开发环境下，直接报警告，不能修改值 */
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    /* 也不能删除属性 */
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  /* get, set 覆盖基础的 */
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
