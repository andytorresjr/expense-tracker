export default function Placeholder({ title, note }: { title: string; note: string }): React.JSX.Element {
  return (
    <div className="card-panel p-10 text-center text-slate-500">
      <div className="text-2xl mb-2">{title}</div>
      <p>{note}</p>
    </div>
  )
}
