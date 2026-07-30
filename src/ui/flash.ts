const BLINKS = 6
const BLINK_MS = 420

/**
 * 全局只允许一个高亮在闪。
 * 用 WeakMap 按元素记的话，连续定位到不同节点时上一个还会继续闪，
 * 屏幕上同时亮两处，反而分不清这次跳到哪了。
 */
let active: Animation | null = null

/**
 * 跳转定位后让目标卡片边框闪几下。
 *
 * 用 Web Animations API 而不是 CSS class：class 是声明式渲染在管的，
 * 命令式加上去的 class 随时可能被重渲染覆盖掉，实测只闪一下就没了。
 * el.animate() 直接挂在元素上，跟 DOM 属性无关，重渲染也打断不了。
 * 同时用 box-shadow 而不是 border —— 不改变布局尺寸，不会干扰滚动定位。
 */
export function flashElement(el: Element) {
  cancelFlash()

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6aa8ff'
  const off = '0 0 0 0 rgba(0,0,0,0)'
  const on = `0 0 0 2px ${accent}`

  const anim = el.animate(
    [
      { boxShadow: off, offset: 0 },
      { boxShadow: on, offset: 0.5 },
      { boxShadow: off, offset: 1 },
    ],
    { duration: BLINK_MS, iterations: BLINKS, easing: 'ease-in-out' },
  )
  active = anim
  anim.finished
    .catch(() => {}) // cancel 会让 finished 以 AbortError 拒绝
    .finally(() => {
      if (active === anim) active = null
    })
}

/** 立刻停掉当前高亮（新的定位开始、或载入新文件时调用） */
export function cancelFlash() {
  active?.cancel()
  active = null
}
