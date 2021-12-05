import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'
/* 
  下面定义了几个全局变量
*/
// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
/* WeakMap */
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
/* 
  记录当前的层数
*/
let effectTrackDepth = 0
/*  
  effect 归属标记
*/
export let trackOpBit = 1

/**
 * The bitwise track markers support at most 30 levels of recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 */
/*  
  effect依赖嵌套最大层数 (注：嵌套就比如在一个依赖中带有其他依赖，如：computed中使用computed) 
  最多支持30层 如果超出了这个范围 会进入清除模式
*/
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}
/* 
  全局 effectStack “栈”
*/
const effectStack: ReactiveEffect[] = []
/* 
  当前激活的effect
*/
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

/* 
  感觉这个相当于Watcher
  ReactiveEffect 类
  收集依赖的类
  每次setup 都会new ReactiveEffect 
  在ReactiveEffect 中有deps 收集依赖，把diff控制在了组件级别
  这个类特别重要

  activeEffect就是ReactiveEffect的实例 （这句话很重要）

  run

  stop 
*/
export class ReactiveEffect<T = any> {
  active = true
  deps: Dep[] = []

  // can be attached after creation
  computed?: boolean
  allowRecurse?: boolean
  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void
  /* 
    学到一个新的知识,
    在参数前面加public，就不需要提前定义了，可以直接this.fn() 使用
  */
  constructor(
    /* fn 就是数据变化之后需要执行的副作用函数 */
    public fn: () => T,
    /* 有时候，effect并不是立刻去执行，而是其他的effect去触发，会先放入队列中，等待执行 */
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope | null
  ) {
    /* 
      第一个参数是函数  componentUpdateFn
    */
    recordEffectScope(this, scope)
  }
  /* 
    这个就是当年Vue2里面的update
  */
  run() {
    /* 
      run 函数，是依赖执行的开始
      scheduler内部其实也是调用了run函数
      依赖的执行模仿了函数的入栈和出栈的方式
      active 默认是TRUE
      
    */
    if (!this.active) {
      /* 如果是FALSE的话，直接执行函数 componentUpdateFn */
      return this.fn()
    }
    if (!effectStack.includes(this)) {
      try {
        /* 将当前触发的effect进入 栈 区 */
        effectStack.push((activeEffect = this))
        /* 应该去追踪 */
        enableTracking()
        /* 每嵌套一层，就记录一层 */
        trackOpBit = 1 << ++effectTrackDepth
        /* 
          如果嵌套的层数，没有超过最大限制，初始化Dep
        */
        if (effectTrackDepth <= maxMarkerBits) {
          /* 初始化dep 标记为收集过的依赖
            记录这个effect的dep全部是已经收集过的
          */
          initDepMarkers(this)
        } else {
          /* 一般是不超过，不会执行这里 */
          cleanupEffect(this)
        }
        /* 执行函数，里面有patch，就去执行更新DOM 
          按位运算优化追踪
          执行当前的effect的函数，但是这个函数可能会带有其他依赖
          这就形成了嵌套依赖
          trackOpBit 会作为当前依赖的唯一标识
          每次effectTrackDepth都会加1，执行完后，会减1
        
        */
        return this.fn()
      } finally {
        if (effectTrackDepth <= maxMarkerBits) {
          /* 如果执行完effect之后，没有嵌套依赖，
          会去栈中找到当前的effect，清除 w,n 标记
          */
          finalizeDepMarkers(this)
        }

        trackOpBit = 1 << --effectTrackDepth
        /* 
          重置是否应该去追踪，并将当前的 effect 移除栈区
        */
        resetTracking()
        effectStack.pop()
        /* 
          如果n是0，代表所有的effect执行完了，activeEffect 赋值为undefined
          如果不是0，说明还有effect，指向栈的最后一个effect
        */
        const n = effectStack.length
        activeEffect = n > 0 ? effectStack[n - 1] : undefined
      }
    }
  }

  stop() {
    if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      /* 执行stop，关闭active */
      this.active = false
    }
  }
}
/* 
  清除依赖的所有dep中删除effect 清除effect的信息
*/
function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const _effect = new ReactiveEffect(fn)
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  if (!options || !options.lazy) {
    _effect.run()
  }
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

let shouldTrack = true
const trackStack: boolean[] = []
/* 
  给数组使用的
  全局暂停追踪
*/
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}
/* 
  全局允许追踪
*/
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}
/* 
  恢复到 enableTracking() 或者是 pauseTracking()之前
*/
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/* 
  reactive 的 依赖收集
  reactive 用的 WeakMap 存target
  用 Map 存 key,和dep
  dep 是个Set
  整个track来说，实际有点绕
  这里存储数据有点绕
  1. 用 WeakMap 存 key: target, value: new Map()
  2. Map 存对象的属性和dep: key: target的key, value: new Set()
  3. Set 里面存 activeEffect 实例
*/
export function track(target: object, type: TrackOpTypes, key: unknown) {
  /* 如果正在收集依赖的话，就直接return */
  if (!isTracking()) {
    return
  }
  /* 
    防止重复收集依赖
  */
  let depsMap = targetMap.get(target)
  /* 如果没有存过， set target */
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  let dep = depsMap.get(key)
  /* 如果这个key 没有创建过dep, set 一下 */
  if (!dep) {
    /* dep 值 是个Set， dep 赋值了一个空的Set */
    depsMap.set(key, (dep = createDep()))
  }

  const eventInfo = __DEV__
    ? { effect: activeEffect, target, type, key }
    : undefined
  /* 
    dep 里面存了 ReactiveEffect 的实例 
    收集副作用 effect
    上面的代码，是为了trackEffects做准备的
  */
  trackEffects(dep, eventInfo)
}
/* 
  判断是否应该追踪
*/
export function isTracking() {
  return shouldTrack && activeEffect !== undefined
}

/* 
  这个函数很重要，依赖收集
*/
export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  
  let shouldTrack = false
  if (effectTrackDepth <= maxMarkerBits) {
    /* 验证是否为新收集的依赖 */
    if (!newTracked(dep)) {
      dep.n |= trackOpBit // set newly tracked
      /* 
        判断是否是收集过的依赖
      */
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // Full cleanup mode.
    shouldTrack = !dep.has(activeEffect!)
  }
  /* 
    activeEffect 是ReactiveEffect 的实例对象，
    {
        fn: Function,
        scheduler: scheduler,
        active: true,
        deps: [],
        run() {},
        stop() {},
    }
    长这个样子
*/
  if (shouldTrack) {
    /* 
      把 activeEffect 塞到dep里面 
      把实例对象存起来
      activeEffect 后面带叹号，是TS的非空断言
    */
    dep.add(activeEffect!)
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        Object.assign(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo
        )
      )
    }
  }
}
/* 
  reactive 的 trigger
  触发依赖， 也就是notice， 从而更新视图
  https://juejin.cn/post/7036367619221356575
*/
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 从 存储 target中的WeakMap 获取目标对象
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    /* 如果没有被收集，就直接返回 */
    return
  }
  /* 暂存依赖数据 */
  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    /* 清空依赖 */
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    /* 数组
      处理数组通过 length 变更的情况
     */
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 通过 schedule runs 的情况
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined
  /* 
    执行 triggerEffects  也就是 notice 去触发 实例的 run 函数
  */
  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        /* 执行 更新依赖 effect */
        triggerEffects(deps[0])
      }
    }
  } else {
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}
/*  
  触发依赖
  这里相当于notice
  scheduler: 调度程序
*/
export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  for (const effect of isArray(dep) ? dep : [...dep]) {

    if (effect !== activeEffect || effect.allowRecurse) {
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }
      // 如果有scheduler 执行scheduler
      if (effect.scheduler) {
        // 是为了提供我想要让你什么时候执行就什么时候执行的能力，也就是可以自己调度的能力。
        effect.scheduler()
      } else {
        /* 调用run函数 像是VUE2 里面的update */
        effect.run()
      }
    }
  }
}

/* 
  总结： 

  ref  和 reactive 的区别就是，dep 存储位置的不同

  ref 是把 dep 放在了RefImpl 实例中
  reactive 是把 dep 放在了公共targetMap中

  参考资料： https://juejin.cn/post/7033604157340811300

*/