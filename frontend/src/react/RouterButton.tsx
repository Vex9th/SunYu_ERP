import { Button, type ButtonProps } from 'antd'
import { useHref, useLinkClickHandler, type To } from 'react-router-dom'

/** 保留 Ant Design 外观和路由行为，DOM 中只生成一个链接。 */
export function RouterButton({ to, ...props }: Omit<ButtonProps, 'href' | 'onClick'> & { to: To }) {
  const href = useHref(to)
  const onClick = useLinkClickHandler<HTMLAnchorElement | HTMLButtonElement>(to, { target: props.target })
  return <Button {...props} href={href} onClick={onClick} />
}
