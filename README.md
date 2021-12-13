# Vue3 源码学习

![Alt](https://repobeats.axiom.co/api/embed/3be4350d290bf2684e57b659d51fb72f5b8d214b.svg "Repobeats analytics image")


## 1,初始化流程

1. `createApp(App) // @vue/runtime-dom` 创建Vue实例，扩展一些方法，比如use, mount, mixin, component, directive; 方法最终的定义位置为 `runtime-core/src/apiCreateApp.ts`
2. createRenderer -> baseCreateRenderer() 对外暴露三个方法，render、hydrate、createApp； hydrate的实际作用是createApp返回的vue实例对象
3. createAppAPI(render, hydrate)； 返回createApp() 并且扩展了一些实例方法，链式调用
4. mount(rootContainer: HostElement, isHydrate?: boolean) 作用， 把传入的根组件转化为VNode，然后挂载到rootContainer 中
5. render(vnode, container) 作用： 将VNode渲染到容器container上
6. patch(n1, n2, container)；n1 一开始是空的，根据n2的类型执行不同的函数，如果是组件，就会执行 processComponent
7. processComponent(n1, n2, container); 执行组件的挂载或者更新， 因为n1一开始是空，所以直接执行挂载 mountComponent
8. mountComponent(initialVNode, container); 创建组件实例 createComponentInstance ，设置数据状态 setupComponent
9. setupComponent(); 位于component.ts
10. setupStatefulComponent() 调用 callWithErrorHandling，也就是 调用setup 函数
11. callWithErrorHandling() 调用setup() 传入两个参数 props 和  setupContext
12. handleSetupResult(instance, setupResult, isSSR); 处理setup 函数返回的对象

## 2,目录模块

compile: 可以简单理解为将.vue 文件编译为 浏览器能识别的.js 文件
runtime: 可以理解成，程序运行时，就是程序被编译完成后，在浏览器打开，运行代码，直到程序关闭


* runtime-dom   运行时dom 关api，属性，事件处理
* runtime-core  运行时核心实例相关代码（平台无关）
* shared 内部工具库
* compiler-core
* compiler-dom
* reactivity 响应式模块，可以与任何框架配合使用
* compiler-sfc Vue单文件组件编译工具
* vue 完整源码产生目录
 
vue.global.js：是包含编译器和运行时的“完整”构建版本，因此它支持动态编译模板
vue.runtime.global.js：只包含运行时，并且需要在构建步骤期间预编译模板


## reactivity

主要是分为两种，reactive 和 ref


## reactive

总体来说，做了两件事，

1. 把对象转化为响应式对象
2. 收集依赖，更新依赖

### createReactiveObject 函数

* reactive 核心函数
* createReactiveObject 函数核心就是Proxy
* 目的是可以监听到用户的get 和 set的动作
* 使用缓存做了优化
* 参数proxyMap 其实就是reactiveMap， 用来做缓存的


总结：

Vue3 通过两个API，Proxy和Reflect 把普通对象转换成响应式对象

当数据读取的时候，会触发get收集依赖，收集存储在一个WeakMap中，其中key是target（目标对象），value是一个Map数据结构，这个Map的key是我们读取数据对应的key（target的key），value是一个Set数据结构。Set存储的是activeEffect

当数据变更的时候，会触发set更新依赖，更新依赖的时候，会先去WeakMap中找到target对应的数据，找到后经过一番依赖数据标准后，遍历依赖，执行依赖的每一个activeEffect

1. 为什么用weakMap 存储响应式对象？
  用weakMap的用处防止内存泄漏，当变量的引用不存在的时候，自动会清楚内存；缓存响应式数据是为了防止重复收集

2. 依赖数据存储分别用了 weakMap、Map、Set三种数据结构存储，为什么要这样设计呢？

  * 用weakMap与上面原因一样，一是防止内存泄漏，二是防止重复收集
  * 用Map存储而不是用Object，是因为map的键可以是任意值，而Object 的键必须是一个 String 或是Symbol
  * 用Set当然是为了去重了，Set存储的是数据不能重复的


## ref

总结

ref这个api即可把包裹基本数据类型，也可以包裹引用数据类型。
ref会先设置value的get、set属性，
get的时候会调用trackRefValue，trackRefValue内部调用trackEffects收集依赖并存储到ref.dep中；
set的时候如果value是对象或者数组，则会reative把普通对象转换响应式数据，然后调用triggerRefValue，把ref.dep拿出来交给triggerEffects执行，更新依赖
如果包裹的是引用数据类型，其收集依赖和更新依赖的逻辑还是执行reative这个api。
ref的原理依赖于reactive这个api。
如果ref包裹基本数据类型，更建议shallowRef这个api，会一些判断，不需要去处理引用数据类型这种情况了。


## 参考资料

[带着问题阅读源码Vue3.2-reactive实现原理](https://juejin.cn/post/7036367619221356575)



## 性能优化

* 移除一些冷门的feature
* 引入 tree-shaking (依赖 ES2015模块语法的静态结构， 通过编译阶段的静态分析，找到没有引入的模块，打上标记)
* 数据劫持
* Proxy API 是不能监听到内部深层次的对象变化， 因此，处理方式是在Vue3.0 ， 在getter中去递归响应式 （
这样的好处是，真正访问到的内部对象，才会变成响应式，不是无脑递归， 提升了性能
）

##  编译优化
* patch 过程优化
* Vue2的数据更新，并触发重新渲染的颗粒度是组件级别的
* Block true 是一个将模板基于动态节点指令切割的嵌套区块，每个区块内部的节点结构是固定的
* 借助 block tree 把VNode 的更新性能，从跟模板整体大小相关，提升为，与动态内容的数量相关
* slot 的编译优化
* 事件侦听函数的缓存优化
* 在运行时，重写了diff算法

## mixin 问题

* 命名冲突
* 数据来源不清晰


## Vue团队核心成员开发的39行小工具 install-pkg 安装包，值得一学！

https://lxchuan12.gitee.io/install-pkg/#_1-%E5%89%8D%E8%A8%80

# vue-next [![npm](https://img.shields.io/npm/v/vue/next.svg)](https://www.npmjs.com/package/vue/v/next) [![build status](https://github.com/vuejs/vue-next/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/vuejs/vue-next/actions/workflows/ci.yml)

This is the repository for Vue 3.0.

## Quickstart

- Via CDN: `<script src="https://unpkg.com/vue@next"></script>`
- In-browser playground on [Codepen](https://codepen.io/yyx990803/pen/OJNoaZL)
- Scaffold via [Vite](https://github.com/vitejs/vite):

  ```bash
  # npm 6.x
  npm init vite@latest my-vue-app --template vue
  # npm 7+, extra double-dash is needed:
  npm init vite@latest my-vue-app -- --template vue
  # yarn
  yarn create vite my-vue-app --template vue
  ```

- Scaffold via [vue-cli](https://cli.vuejs.org/):

  ```bash
  npm install -g @vue/cli # OR yarn global add @vue/cli
  vue create hello-vue3
  # select vue 3 preset
  ```

## Changes from Vue 2

Please consult the [Migration Guide](https://v3.vuejs.org/guide/migration/introduction.html).

Also note: Vue 3 does not support IE11 ([RFC](https://github.com/vuejs/rfcs/blob/master/active-rfcs/0038-vue3-ie11-support.md) | [Discussion](https://github.com/vuejs/rfcs/discussions/296)).

## Supporting Libraries

All of our official libraries and tools now support Vue 3, but most of them are still in beta status and distributed under the `next` dist tag on NPM. **We are planning to stabilize and switch all projects to use the `latest` dist tag in early 2021.**

### Vue CLI

As of v4.5.0, `vue-cli` now provides built-in option to choose Vue 3 preset when creating a new project. You can upgrade `vue-cli` and run `vue create` to create a Vue 3 project today.

### Vue Router

Vue Router 4.0 provides Vue 3 support and has a number of breaking changes of its own. Check out its [Migration Guide](https://next.router.vuejs.org/guide/migration/) for full details.

- [![beta](https://img.shields.io/npm/v/vue-router/next.svg)](https://www.npmjs.com/package/vue-router/v/next)
- [GitHub](https://github.com/vuejs/vue-router-next)
- [RFCs](https://github.com/vuejs/rfcs/pulls?q=is%3Apr+is%3Amerged+label%3Arouter)

### Vuex

Vuex 4.0 provides Vue 3 support with largely the same API as 3.x. The only breaking change is [how the plugin is installed](https://github.com/vuejs/vuex/tree/4.0#breaking-changes).

- [![beta](https://img.shields.io/npm/v/vuex/next.svg)](https://www.npmjs.com/package/vuex/v/next)
- [GitHub](https://github.com/vuejs/vuex/tree/4.0)

### Devtools Extension

We are working on a new version of the Devtools with a new UI and refactored internals to support multiple Vue versions. The new version is currently in beta and only supports Vue 3 (for now). Vuex and Router integration is also work in progress.

- For Chrome: [Install from Chrome web store](https://chrome.google.com/webstore/detail/vuejs-devtools/ljjemllljcmogpfapbkkighbhhppjdbg?hl=en)

  - Note: the beta channel may conflict with the stable version of devtools so you may need to temporarily disable the stable version for the beta channel to work properly.

- For Firefox: [Download the signed extension](https://github.com/vuejs/vue-devtools/releases/tag/v6.0.0-beta.2) (`.xpi` file under Assets)

### IDE Support

It is recommended to use [VSCode](https://code.visualstudio.com/). There are currently two viable extensions for Single-File Components (SFCs) support:

- [Vetur](https://marketplace.visualstudio.com/items?itemName=octref.vetur) (recommended if you are used to Vetur features)
- [Volar](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.volar) (recommended if using TypeScript with SFCs, or `<script setup>` syntax)

### TypeScript Support

- All Vue 3 packages ship with types.
- [vue-tsc](https://github.com/johnsoncodehk/vue-tsc) perform TypeScript type checks / diagnostics on Vue SFCs via the command line.
- [vue-dts-gen](https://github.com/egoist/vue-dts-gen): generate TypeScript definitions from Vue SFCs.

### Other Projects

| Project               | NPM                             | Repo                 |
| --------------------- | ------------------------------- | -------------------- |
| @vue/babel-plugin-jsx | [![rc][jsx-badge]][jsx-npm]     | [[GitHub][jsx-code]] |
| eslint-plugin-vue     | [![stable][epv-badge]][epv-npm] | [[GitHub][epv-code]] |
| @vue/test-utils       | [![beta][vtu-badge]][vtu-npm]   | [[GitHub][vtu-code]] |
| vue-class-component   | [![beta][vcc-badge]][vcc-npm]   | [[GitHub][vcc-code]] |
| vue-loader            | [![beta][vl-badge]][vl-npm]     | [[GitHub][vl-code]]  |
| rollup-plugin-vue     | [![beta][rpv-badge]][rpv-npm]   | [[GitHub][rpv-code]] |

[jsx-badge]: https://img.shields.io/npm/v/@vue/babel-plugin-jsx.svg
[jsx-npm]: https://www.npmjs.com/package/@vue/babel-plugin-jsx
[jsx-code]: https://github.com/vuejs/jsx-next
[vd-badge]: https://img.shields.io/npm/v/@vue/devtools/beta.svg
[vd-npm]: https://www.npmjs.com/package/@vue/devtools/v/beta
[vd-code]: https://github.com/vuejs/vue-devtools/tree/next
[epv-badge]: https://img.shields.io/npm/v/eslint-plugin-vue.svg
[epv-npm]: https://www.npmjs.com/package/eslint-plugin-vue
[epv-code]: https://github.com/vuejs/eslint-plugin-vue
[vtu-badge]: https://img.shields.io/npm/v/@vue/test-utils/next.svg
[vtu-npm]: https://www.npmjs.com/package/@vue/test-utils/v/next
[vtu-code]: https://github.com/vuejs/vue-test-utils-next
[jsx-badge]: https://img.shields.io/npm/v/@ant-design-vue/babel-plugin-jsx.svg
[jsx-npm]: https://www.npmjs.com/package/@ant-design-vue/babel-plugin-jsx
[jsx-code]: https://github.com/vueComponent/jsx
[vcc-badge]: https://img.shields.io/npm/v/vue-class-component/next.svg
[vcc-npm]: https://www.npmjs.com/package/vue-class-component/v/next
[vcc-code]: https://github.com/vuejs/vue-class-component/tree/next
[vl-badge]: https://img.shields.io/npm/v/vue-loader/next.svg
[vl-npm]: https://www.npmjs.com/package/vue-loader/v/next
[vl-code]: https://github.com/vuejs/vue-loader/tree/next
[rpv-badge]: https://img.shields.io/npm/v/rollup-plugin-vue/next.svg
[rpv-npm]: https://www.npmjs.com/package/rollup-plugin-vue/v/next
[rpv-code]: https://github.com/vuejs/rollup-plugin-vue/tree/next
