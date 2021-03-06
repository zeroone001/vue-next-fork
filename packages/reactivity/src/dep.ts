import { ReactiveEffect, trackOpBit } from './effect'

export type Dep = Set<ReactiveEffect> & TrackedMarkers

/**
 * wasTracked and newTracked maintain the status for several levels of effect
 * tracking recursion. One bit per level is used to define whether the dependency
 * was/is tracked.
 */
type TrackedMarkers = {
  /**
   * wasTracked
   */
  w: number
  /**
   * newTracked
   */
  n: number
}
/* 
  Set 存 effect
*/
export const createDep = (effects?: ReactiveEffect[]): Dep => {
  const dep = new Set<ReactiveEffect>(effects) as Dep
  /*
    w, n 是干啥的？
    将这些依赖标记为新收集的依赖
    这个地方其实就是自己学到的算法
    如果直接去操作删除清空，是很消耗性能的
    不需要每次都把所有的依赖清空了，再去收集依赖，
    可以通过w和n两个标记判断依赖是否为需要的，减少了对内存的使用
    就是打个标记，不操作这个了
   */
  dep.w = 0
  dep.n = 0
  return dep
}
/* 
  验证是否为收集过的依赖
*/
export const wasTracked = (dep: Dep): boolean => (dep.w & trackOpBit) > 0
/* 
  验证是否为新收集的依赖
*/
export const newTracked = (dep: Dep): boolean => (dep.n & trackOpBit) > 0

export const initDepMarkers = ({ deps }: ReactiveEffect) => {
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      // 标记依赖已经收集
      deps[i].w |= trackOpBit // set was tracked
    }
  }
}
/* 

*/
export const finalizeDepMarkers = (effect: ReactiveEffect) => {
  const { deps } = effect
  if (deps.length) {
    let ptr = 0
    for (let i = 0; i < deps.length; i++) {
      const dep = deps[i]
      if (wasTracked(dep) && !newTracked(dep)) {
        /* 
          曾经被收集过的，但不是新的依赖，需要删除
          原因是可能有一些依赖是不需要的，就从deps移除
          性能优化
        */
        dep.delete(effect)
      } else {
        deps[ptr++] = dep
      }
      // clear bits
      dep.w &= ~trackOpBit
      dep.n &= ~trackOpBit
    }
    deps.length = ptr
  }
}
