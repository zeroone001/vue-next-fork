import { VNode, VNodeChild, isVNode } from './vnode'
import {
  pauseTracking,
  resetTracking,
  shallowReadonly,
  proxyRefs,
  EffectScope,
  markRaw,
  track,
  TrackOpTypes
} from '@vue/reactivity'
import {
  ComponentPublicInstance,
  PublicInstanceProxyHandlers,
  createDevRenderContext,
  exposePropsOnRenderContext,
  exposeSetupStateOnRenderContext,
  ComponentPublicInstanceConstructor,
  publicPropertiesMap,
  RuntimeCompiledPublicInstanceProxyHandlers
} from './componentPublicInstance'
import {
  ComponentPropsOptions,
  NormalizedPropsOptions,
  initProps,
  normalizePropsOptions
} from './componentProps'
import { Slots, initSlots, InternalSlots } from './componentSlots'
import { warn } from './warning'
import { ErrorCodes, callWithErrorHandling, handleError } from './errorHandling'
import { AppContext, createAppContext, AppConfig } from './apiCreateApp'
import { Directive, validateDirectiveName } from './directives'
import {
  applyOptions,
  ComponentOptions,
  ComputedOptions,
  MethodOptions
} from './componentOptions'
import {
  EmitsOptions,
  ObjectEmitsOptions,
  EmitFn,
  emit,
  normalizeEmitsOptions
} from './componentEmits'
import {
  EMPTY_OBJ,
  isFunction,
  NOOP,
  isObject,
  NO,
  makeMap,
  isPromise,
  ShapeFlags,
  extend
} from '@vue/shared'
import { SuspenseBoundary } from './components/Suspense'
import { CompilerOptions } from '@vue/compiler-core'
import { markAttrsAccessed } from './componentRenderUtils'
import { currentRenderingInstance } from './componentRenderContext'
import { startMeasure, endMeasure } from './profiling'
import { convertLegacyRenderFn } from './compat/renderFn'
import { globalCompatConfig, validateCompatConfig } from './compat/compatConfig'
import { SchedulerJob } from './scheduler'

export type Data = Record<string, unknown>

/**
 * For extending allowed non-declared props on components in TSX
 */
export interface ComponentCustomProps {}

/**
 * Default allowed non-declared props on component in TSX
 */
export interface AllowedComponentProps {
  class?: unknown
  style?: unknown
}

// Note: can't mark this whole interface internal because some public interfaces
// extend it.
export interface ComponentInternalOptions {
  /**
   * @internal
   */
  __scopeId?: string
  /**
   * @internal
   */
  __cssModules?: Data
  /**
   * @internal
   */
  __hmrId?: string
  /**
   * Compat build only, for bailing out of certain compatibility behavior
   */
  __isBuiltIn?: boolean
  /**
   * This one should be exposed so that devtools can make use of it
   */
  __file?: string
}

export interface FunctionalComponent<P = {}, E extends EmitsOptions = {}>
  extends ComponentInternalOptions {
  // use of any here is intentional so it can be a valid JSX Element constructor
  (props: P, ctx: Omit<SetupContext<E>, 'expose'>): any
  props?: ComponentPropsOptions<P>
  emits?: E | (keyof E)[]
  inheritAttrs?: boolean
  displayName?: string
}

export interface ClassComponent {
  new (...args: any[]): ComponentPublicInstance<any, any, any, any, any>
  __vccOpts: ComponentOptions
}

/**
 * Concrete component type matches its actual value: it's either an options
 * object, or a function. Use this where the code expects to work with actual
 * values, e.g. checking if its a function or not. This is mostly for internal
 * implementation code.
 */
export type ConcreteComponent<
  Props = {},
  RawBindings = any,
  D = any,
  C extends ComputedOptions = ComputedOptions,
  M extends MethodOptions = MethodOptions
> =
  | ComponentOptions<Props, RawBindings, D, C, M>
  | FunctionalComponent<Props, any>

/**
 * A type used in public APIs where a component type is expected.
 * The constructor type is an artificial type returned by defineComponent().
 */
export type Component<
  Props = any,
  RawBindings = any,
  D = any,
  C extends ComputedOptions = ComputedOptions,
  M extends MethodOptions = MethodOptions
> =
  | ConcreteComponent<Props, RawBindings, D, C, M>
  | ComponentPublicInstanceConstructor<Props>

export { ComponentOptions }

type LifecycleHook<TFn = Function> = TFn[] | null

export const enum LifecycleHooks {
  BEFORE_CREATE = 'bc',
  CREATED = 'c',
  BEFORE_MOUNT = 'bm',
  MOUNTED = 'm',
  BEFORE_UPDATE = 'bu',
  UPDATED = 'u',
  BEFORE_UNMOUNT = 'bum',
  UNMOUNTED = 'um',
  DEACTIVATED = 'da',
  ACTIVATED = 'a',
  RENDER_TRIGGERED = 'rtg',
  RENDER_TRACKED = 'rtc',
  ERROR_CAPTURED = 'ec',
  SERVER_PREFETCH = 'sp'
}

export interface SetupContext<E = EmitsOptions> {
  attrs: Data
  slots: Slots
  emit: EmitFn<E>
  expose: (exposed?: Record<string, any>) => void
}

/**
 * @internal
 */
export type InternalRenderFunction = {
  (
    ctx: ComponentPublicInstance,
    cache: ComponentInternalInstance['renderCache'],
    // for compiler-optimized bindings
    $props: ComponentInternalInstance['props'],
    $setup: ComponentInternalInstance['setupState'],
    $data: ComponentInternalInstance['data'],
    $options: ComponentInternalInstance['ctx']
  ): VNodeChild
  _rc?: boolean // isRuntimeCompiled

  // __COMPAT__ only
  _compatChecked?: boolean // v3 and already checked for v2 compat
  _compatWrapped?: boolean // is wrapped for v2 compat
}

/**
 * We expose a subset of properties on the internal instance as they are
 * useful for advanced external libraries and tools.
 */
export interface ComponentInternalInstance {
  uid: number
  type: ConcreteComponent
  parent: ComponentInternalInstance | null
  root: ComponentInternalInstance
  appContext: AppContext
  /**
   * Vnode representing this component in its parent's vdom tree
   */
  vnode: VNode
  /**
   * The pending new vnode from parent updates
   * @internal
   */
  next: VNode | null
  /**
   * Root vnode of this component's own vdom tree
   */
  subTree: VNode
  /**
   * Bound effect runner to be passed to schedulers
   */
  update: SchedulerJob
  /**
   * The render function that returns vdom tree.
   * @internal
   */
  render: InternalRenderFunction | null
  /**
   * SSR render function
   * @internal
   */
  ssrRender?: Function | null
  /**
   * Object containing values this component provides for its descendents
   * @internal
   */
  provides: Data
  /**
   * Tracking reactive effects (e.g. watchers) associated with this component
   * so that they can be automatically stopped on component unmount
   * @internal
   */
  scope: EffectScope
  /**
   * cache for proxy access type to avoid hasOwnProperty calls
   * @internal
   */
  accessCache: Data | null
  /**
   * cache for render function values that rely on _ctx but won't need updates
   * after initialized (e.g. inline handlers)
   * @internal
   */
  renderCache: (Function | VNode)[]

  /**
   * Resolved component registry, only for components with mixins or extends
   * @internal
   */
  components: Record<string, ConcreteComponent> | null
  /**
   * Resolved directive registry, only for components with mixins or extends
   * @internal
   */
  directives: Record<string, Directive> | null
  /**
   * Resolved filters registry, v2 compat only
   * @internal
   */
  filters?: Record<string, Function>
  /**
   * resolved props options
   * @internal
   */
  propsOptions: NormalizedPropsOptions
  /**
   * resolved emits options
   * @internal
   */
  emitsOptions: ObjectEmitsOptions | null
  /**
   * resolved inheritAttrs options
   * @internal
   */
  inheritAttrs?: boolean
  /**
   * is custom element?
   */
  isCE?: boolean
  /**
   * custom element specific HMR method
   */
  ceReload?: (newStyles?: string[]) => void

  // the rest are only for stateful components ---------------------------------

  // main proxy that serves as the public instance (`this`)
  proxy: ComponentPublicInstance | null

  // exposed properties via expose()
  exposed: Record<string, any> | null
  exposeProxy: Record<string, any> | null

  /**
   * alternative proxy used only for runtime-compiled render functions using
   * `with` block
   * @internal
   */
  withProxy: ComponentPublicInstance | null
  /**
   * This is the target for the public instance proxy. It also holds properties
   * injected by user options (computed, methods etc.) and user-attached
   * custom properties (via `this.x = ...`)
   * @internal
   */
  ctx: Data

  // state
  data: Data
  props: Data
  attrs: Data
  slots: InternalSlots
  refs: Data
  emit: EmitFn
  /**
   * used for keeping track of .once event handlers on components
   * @internal
   */
  emitted: Record<string, boolean> | null
  /**
   * used for caching the value returned from props default factory functions to
   * avoid unnecessary watcher trigger
   * @internal
   */
  propsDefaults: Data
  /**
   * setup related
   * @internal
   */
  setupState: Data
  /**
   * devtools access to additional info
   * @internal
   */
  devtoolsRawSetupState?: any
  /**
   * @internal
   */
  setupContext: SetupContext | null

  /**
   * suspense related
   * @internal
   */
  suspense: SuspenseBoundary | null
  /**
   * suspense pending batch id
   * @internal
   */
  suspenseId: number
  /**
   * @internal
   */
  asyncDep: Promise<any> | null
  /**
   * @internal
   */
  asyncResolved: boolean

  // lifecycle
  isMounted: boolean
  isUnmounted: boolean
  isDeactivated: boolean
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_CREATE]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.CREATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_MOUNT]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.MOUNTED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_UPDATE]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.UPDATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_UNMOUNT]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.UNMOUNTED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.RENDER_TRACKED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.RENDER_TRIGGERED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.ACTIVATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.DEACTIVATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.ERROR_CAPTURED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.SERVER_PREFETCH]: LifecycleHook<() => Promise<unknown>>
}

const emptyAppContext = createAppContext()

let uid = 0
/* 
  创建组件实例
*/
export function createComponentInstance(
  vnode: VNode,
  parent: ComponentInternalInstance | null,
  suspense: SuspenseBoundary | null
) {
  const type = vnode.type as ConcreteComponent
  /* 继承父组件实例上的appContext， 如果是根组件，直接从根VNode中取 */
  const appContext =
    (parent ? parent.appContext : vnode.appContext) || emptyAppContext

  const instance: ComponentInternalInstance = {
    /* 组件唯一id */
    uid: uid++,
    /* 组件vnode */
    vnode,
    type,
    /* 父组件实例 */
    parent,
    /* app 上下文 */
    appContext,
    /* 根组件实例 */
    root: null!, // to be immediately set
    /* 新的组件VNode */
    next: null,
    /* 子节点VNode */
    subTree: null!, // will be set synchronously right after creation
    /* 带副作用更新函数 */
    update: null!, // will be set synchronously right after creation
    scope: new EffectScope(true /* detached */),
    /* render函数 */
    render: null,
    /* 渲染上下文代理 */
    proxy: null,
    exposed: null,
    exposeProxy: null,
    /* 带有with 区块的渲染上下文代理 */
    withProxy: null,
    /* 依赖注入相关 */
    provides: parent ? parent.provides : Object.create(appContext.provides),
    /* 渲染代理的属性访问缓存 */
    accessCache: null!,
    /* 渲染缓存 */
    renderCache: [],

    // local resovled assets
    components: null,
    directives: null,

    // resolved props and emits options
    propsOptions: normalizePropsOptions(type, appContext),
    emitsOptions: normalizeEmitsOptions(type, appContext),

    // emit
    emit: null!, // to be set immediately
    emitted: null,

    // props default value
    propsDefaults: EMPTY_OBJ,

    // inheritAttrs
    inheritAttrs: type.inheritAttrs,

    // state
    /* 渲染上下文 */
    ctx: EMPTY_OBJ,
    /* data 数据 */
    data: EMPTY_OBJ,
    /* props数据 */
    props: EMPTY_OBJ,
    /* 普通属性 */
    attrs: EMPTY_OBJ,
    /* 插槽相关 */
    slots: EMPTY_OBJ,
    /* 组件或者DOM的ref引用 */
    refs: EMPTY_OBJ,
    /* setup函数返回的响应式结果 */
    setupState: EMPTY_OBJ,
    /* setup函数的上下文数据 */
    setupContext: null,

    // suspense related
    suspense,
    suspenseId: suspense ? suspense.pendingId : 0,
    /* suspense 异步依赖 */
    asyncDep: null,
    /* suspense 异步依赖 是否都已经处理 */
    asyncResolved: false,

    // lifecycle hooks
    // not using enums here because it results in computed properties
    /* 是否挂载 */
    isMounted: false,
    /* 是否卸载 */
    isUnmounted: false,
    /* 是否激活 */
    isDeactivated: false,
    /* 生命周期 beforeCreate */
    bc: null,
    /* created */
    c: null,
    /* beforeMount */
    bm: null,
    /* mounted */
    m: null,
    /* before update */
    bu: null,
    /* updated */
    u: null,
    /* unmounted */
    um: null,
    /* beforeUnmount */
    bum: null,
    da: null,
    a: null,
    /* render trigger */
    rtg: null,
    /* render tracked */
    rtc: null,
    ec: null,
    /* 派发事件 */
    sp: null
  }
  if (__DEV__) {
    instance.ctx = createDevRenderContext(instance)
  } else {
    /* 初始化渲染上下文 */
    instance.ctx = { _: instance }
  }
  /* 初始化根组件指针 */
  instance.root = parent ? parent.root : instance
  /* 初始化派发事件方法 */
  instance.emit = emit.bind(null, instance)

  // apply custom element special handling
  if (vnode.ce) {
    vnode.ce(instance)
  }

  return instance
}

export let currentInstance: ComponentInternalInstance | null = null

export const getCurrentInstance: () => ComponentInternalInstance | null = () =>
  currentInstance || currentRenderingInstance

export const setCurrentInstance = (instance: ComponentInternalInstance) => {
  currentInstance = instance
  instance.scope.on()
}

export const unsetCurrentInstance = () => {
  currentInstance && currentInstance.scope.off()
  currentInstance = null
}

const isBuiltInTag = /*#__PURE__*/ makeMap('slot,component')

export function validateComponentName(name: string, config: AppConfig) {
  const appIsNativeTag = config.isNativeTag || NO
  if (isBuiltInTag(name) || appIsNativeTag(name)) {
    warn(
      'Do not use built-in or reserved HTML elements as component id: ' + name
    )
  }
}

export function isStatefulComponent(instance: ComponentInternalInstance) {
  return instance.vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT
}

export let isInSSRComponentSetup = false
/* 
  composition-api
  setupComponent： 初始化props，slots， data
*/
export function setupComponent(
  instance: ComponentInternalInstance,
  isSSR = false
) {
  isInSSRComponentSetup = isSSR

  const { props, children } = instance.vnode
  /* 判断是否是一个有状态的组件 */
  const isStateful = isStatefulComponent(instance)
  /* 初始化 props */
  initProps(instance, props, isStateful, isSSR)
  /* 初始化 slots */
  initSlots(instance, children)
  /* 设置有状态的组件实例 */
  const setupResult = isStateful
    ? setupStatefulComponent(instance, isSSR)
    : undefined

  isInSSRComponentSetup = false
  return setupResult
}
/* 
  代理组件实例上下文，调用setup()
*/
function setupStatefulComponent(
  instance: ComponentInternalInstance,
  isSSR: boolean
) {
  const Component = instance.type as ComponentOptions
  /* 开发环境下 */
  if (__DEV__) {
    if (Component.name) {
      validateComponentName(Component.name, instance.appContext.config)
    }
    if (Component.components) {
      const names = Object.keys(Component.components)
      for (let i = 0; i < names.length; i++) {
        validateComponentName(names[i], instance.appContext.config)
      }
    }
    if (Component.directives) {
      const names = Object.keys(Component.directives)
      for (let i = 0; i < names.length; i++) {
        validateDirectiveName(names[i])
      }
    }
    if (Component.compilerOptions && isRuntimeOnly()) {
      warn(
        `"compilerOptions" is only supported when using a build of Vue that ` +
          `includes the runtime compiler. Since you are using a runtime-only ` +
          `build, the options should be passed via your build tool config instead.`
      )
    }
  }

  /* 创建渲染代理的属性访问缓存 */
  instance.accessCache = Object.create(null)
  /* 创建渲染上下文代理 
    对这个的访问，instance.ctx 
    做了代理
  */
  instance.proxy = markRaw(new Proxy(instance.ctx, PublicInstanceProxyHandlers))
  if (__DEV__) {
    exposePropsOnRenderContext(instance)
  }
  // 2. call setup()
  /* 
    setup 方法
    调用setup 函数
    callWithErrorHandling 执行函数
    handleSetupResult 处理结果
  */
  const { setup } = Component
  if (setup) {
    /* 如果setup 函数带参数， 则创建 setup context
    setup.length 代表 setup 函数参数的个数
    */
    const setupContext = (instance.setupContext =
      setup.length > 1 ? createSetupContext(instance) : null)

    setCurrentInstance(instance)
    pauseTracking()
    /* 
      调用setup 函数，传入两个参数 props 和 setupContext
      执行函数，获取结果
    */
    const setupResult = callWithErrorHandling(
      setup,
      instance,
      ErrorCodes.SETUP_FUNCTION,
      [__DEV__ ? shallowReadonly(instance.props) : instance.props, setupContext]
    )

    resetTracking()
    unsetCurrentInstance()
      /* 如果返回的是Promise */
    if (isPromise(setupResult)) {
      setupResult.then(unsetCurrentInstance, unsetCurrentInstance)

      if (isSSR) {
        // return the promise so server-renderer can wait on it
        return setupResult
          .then((resolvedResult: unknown) => {
            handleSetupResult(instance, resolvedResult, isSSR)
          })
          .catch(e => {
            handleError(e, instance, ErrorCodes.SETUP_FUNCTION)
          })
      } else if (__FEATURE_SUSPENSE__) {
        // async setup returned Promise.
        // bail here and wait for re-entry.
        instance.asyncDep = setupResult
      } else if (__DEV__) {
        warn(
          `setup() returned a Promise, but the version of Vue you are using ` +
            `does not support it yet.`
        )
      }
    } else {
      /* 
        处理setup 函数执行后，返回的对象
      */
      handleSetupResult(instance, setupResult, isSSR)
    }
  } else {
    finishComponentSetup(instance, isSSR)
  }
}
/* 
  处理setup 函数执行后，返回的对象
  主要是 instance.render
*/
export function handleSetupResult(
  instance: ComponentInternalInstance,
  setupResult: unknown,
  isSSR: boolean
) {
  if (isFunction(setupResult)) {
    /* 
      如果是函数
    */
    // setup returned an inline render function
    if (__SSR__ && (instance.type as ComponentOptions).__ssrInlineRender) {
      // when the function's name is `ssrRender` (compiled by SFC inline mode),
      // set it as ssrRender instead.
      instance.ssrRender = setupResult
    } else {
      instance.render = setupResult as InternalRenderFunction
    }
  } else if (isObject(setupResult)) {
    /* 如果是对象，这个是常写的 */
    if (__DEV__ && isVNode(setupResult)) {
      warn(
        `setup() should not return VNodes directly - ` +
          `return a render function instead.`
      )
    }
    // setup returned bindings.
    // assuming a render function compiled from template is present.
    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      instance.devtoolsRawSetupState = setupResult
    }
    /* 
      proxyRefs 代理返回的
      把对象给代理 new Proxy 
    */
    instance.setupState = proxyRefs(setupResult)
    if (__DEV__) {
      exposeSetupStateOnRenderContext(instance)
    }
  } else if (__DEV__ && setupResult !== undefined) {
    warn(
      `setup() should return an object. Received: ${
        setupResult === null ? 'null' : typeof setupResult
      }`
    )
  }
  /* 
    最后的setup 的处理
  */
  finishComponentSetup(instance, isSSR)
}

type CompileFunction = (
  template: string | object,
  options?: CompilerOptions
) => InternalRenderFunction

let compile: CompileFunction | undefined
let installWithProxy: (i: ComponentInternalInstance) => void

/**
 * For runtime-dom to register the compiler.
 * Note the exported method uses any to avoid d.ts relying on the compiler types.
 */
export function registerRuntimeCompiler(_compile: any) {
  compile = _compile
  installWithProxy = i => {
    if (i.render!._rc) {
      i.withProxy = new Proxy(i.ctx, RuntimeCompiledPublicInstanceProxyHandlers)
    }
  }
}

// dev only
export const isRuntimeOnly = () => !compile

/* 
  标准化模板或者渲染函数
  兼容 optionsAPI
*/
export function finishComponentSetup(
  instance: ComponentInternalInstance,
  isSSR: boolean,
  skipOptions?: boolean
) {
  const Component = instance.type as ComponentOptions

  if (__COMPAT__) {
    convertLegacyRenderFn(instance)

    if (__DEV__ && Component.compatConfig) {
      validateCompatConfig(Component.compatConfig)
    }
  }

  // template / render function normalization
  // could be already set when returned from setup()
  /* 
    如果没设置render
    下面进行处理
  */
  if (!instance.render) {
    // only do on-the-fly compile if not in SSR - SSR on-the-fly compliation
    // is done by server-renderer
    /* 如果compile 存在  */
    if (!isSSR && compile && !Component.render) {
      const template =
        (__COMPAT__ &&
          instance.vnode.props &&
          instance.vnode.props['inline-template']) ||
        Component.template
      if (template) {
        if (__DEV__) {
          startMeasure(instance, `compile`)
        }
        const { isCustomElement, compilerOptions } = instance.appContext.config
        const { delimiters, compilerOptions: componentCompilerOptions } =
          Component
        const finalCompilerOptions: CompilerOptions = extend(
          extend(
            {
              isCustomElement,
              delimiters
            },
            compilerOptions
          ),
          componentCompilerOptions
        )
        if (__COMPAT__) {
          // pass runtime compat config into the compiler
          finalCompilerOptions.compatConfig = Object.create(globalCompatConfig)
          if (Component.compatConfig) {
            extend(finalCompilerOptions.compatConfig, Component.compatConfig)
          }
        }
        Component.render = compile(template, finalCompilerOptions)
        if (__DEV__) {
          endMeasure(instance, `compile`)
        }
      }
    }
    /* 这里是关键 重点 */
    instance.render = (Component.render || NOOP) as InternalRenderFunction

    // for runtime-compiled render functions using `with` blocks, the render
    // proxy used needs a different `has` handler which is more performant and
    // also only allows a whitelist of globals to fallthrough.
    if (installWithProxy) {
      installWithProxy(instance)
    }
  }

  // support for 2.x options
  if (__FEATURE_OPTIONS_API__ && !(__COMPAT__ && skipOptions)) {
    setCurrentInstance(instance)
    pauseTracking()
    applyOptions(instance)
    resetTracking()
    unsetCurrentInstance()
  }

  // warn missing template/render
  // the runtime compilation of template in SSR is done by server-render
  if (__DEV__ && !Component.render && instance.render === NOOP && !isSSR) {
    /* istanbul ignore if */
    if (!compile && Component.template) {
      warn(
        `Component provided template option but ` +
          `runtime compilation is not supported in this build of Vue.` +
          (__ESM_BUNDLER__
            ? ` Configure your bundler to alias "vue" to "vue/dist/vue.esm-bundler.js".`
            : __ESM_BROWSER__
            ? ` Use "vue.esm-browser.js" instead.`
            : __GLOBAL__
            ? ` Use "vue.global.js" instead.`
            : ``) /* should not happen */
      )
    } else {
      warn(`Component is missing template or render function.`)
    }
  }
}

function createAttrsProxy(instance: ComponentInternalInstance): Data {
  return new Proxy(
    instance.attrs,
    __DEV__
      ? {
          get(target, key: string) {
            markAttrsAccessed()
            track(instance, TrackOpTypes.GET, '$attrs')
            return target[key]
          },
          set() {
            warn(`setupContext.attrs is readonly.`)
            return false
          },
          deleteProperty() {
            warn(`setupContext.attrs is readonly.`)
            return false
          }
        }
      : {
          get(target, key: string) {
            track(instance, TrackOpTypes.GET, '$attrs')
            return target[key]
          }
        }
  )
}

export function createSetupContext(
  instance: ComponentInternalInstance
): SetupContext {
  const expose: SetupContext['expose'] = exposed => {
    if (__DEV__ && instance.exposed) {
      warn(`expose() should be called only once per setup().`)
    }
    instance.exposed = exposed || {}
  }

  let attrs: Data
  if (__DEV__) {
    // We use getters in dev in case libs like test-utils overwrite instance
    // properties (overwrites should not be done in prod)
    return Object.freeze({
      get attrs() {
        return attrs || (attrs = createAttrsProxy(instance))
      },
      get slots() {
        return shallowReadonly(instance.slots)
      },
      get emit() {
        return (event: string, ...args: any[]) => instance.emit(event, ...args)
      },
      expose
    })
  } else {
    return {
      get attrs() {
        return attrs || (attrs = createAttrsProxy(instance))
      },
      slots: instance.slots,
      emit: instance.emit,
      expose
    }
  }
}

export function getExposeProxy(instance: ComponentInternalInstance) {
  if (instance.exposed) {
    return (
      instance.exposeProxy ||
      (instance.exposeProxy = new Proxy(proxyRefs(markRaw(instance.exposed)), {
        get(target, key: string) {
          if (key in target) {
            return target[key]
          } else if (key in publicPropertiesMap) {
            return publicPropertiesMap[key](instance)
          }
        }
      }))
    )
  }
}

const classifyRE = /(?:^|[-_])(\w)/g
const classify = (str: string): string =>
  str.replace(classifyRE, c => c.toUpperCase()).replace(/[-_]/g, '')

export function getComponentName(
  Component: ConcreteComponent
): string | undefined {
  return isFunction(Component)
    ? Component.displayName || Component.name
    : Component.name
}

/* istanbul ignore next */
export function formatComponentName(
  instance: ComponentInternalInstance | null,
  Component: ConcreteComponent,
  isRoot = false
): string {
  let name = getComponentName(Component)
  if (!name && Component.__file) {
    const match = Component.__file.match(/([^/\\]+)\.\w+$/)
    if (match) {
      name = match[1]
    }
  }

  if (!name && instance && instance.parent) {
    // try to infer the name based on reverse resolution
    const inferFromRegistry = (registry: Record<string, any> | undefined) => {
      for (const key in registry) {
        if (registry[key] === Component) {
          return key
        }
      }
    }
    name =
      inferFromRegistry(
        instance.components ||
          (instance.parent.type as ComponentOptions).components
      ) || inferFromRegistry(instance.appContext.components)
  }

  return name ? classify(name) : isRoot ? `App` : `Anonymous`
}

export function isClassComponent(value: unknown): value is ClassComponent {
  return isFunction(value) && '__vccOpts' in value
}
