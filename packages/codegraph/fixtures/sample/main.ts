import { helper, Widget } from './util'

export function run(): number {
  const w = new Widget()
  w.render()
  return helper(41)
}
