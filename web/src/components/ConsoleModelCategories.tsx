import { Badge, Button } from "./ui";

export type PublicModelCategory = { id: string; name: string; description?: string; sort_order?: number; color?: string; enabled?: number };
export type CategorizedModel = { categories?: PublicModelCategory[] };
const colors = ["slate", "blue", "green", "amber", "red", "purple"] as const;
function tone(color: string | undefined): typeof colors[number] { return colors.find(c => c === color) ?? "slate"; }
export function publicModelCategories(offers: CategorizedModel[]): PublicModelCategory[] {
  const categories = new Map<string, PublicModelCategory>();
  for (const offer of offers) for (const category of offer.categories ?? []) {
    if (category.enabled !== 0) categories.set(category.id, category);
  }
  return [...categories.values()].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
export function matchesModelCategory(offers: CategorizedModel[], id: string) {
  const categories = publicModelCategories(offers);
  return id === "" || (id === "__uncategorized" ? !categories.length : categories.some(c => c.id === id));
}
export function ModelCategoryBadges({ offers, all = false }: { offers: CategorizedModel[]; all?: boolean }) {
  const categories = publicModelCategories(offers);
  return <div className="flex flex-wrap gap-1.5" aria-label="模型分类">
    {(all ? categories : categories.slice(0, 2)).map(c => <span key={c.id} title={c.description || c.name}><Badge tone={tone(c.color)}>{c.name}</Badge></span>)}
    {!all && categories.length > 2 ? <span title={categories.slice(2).map(c => c.name).join("、")}><Badge tone="slate">+{categories.length - 2}</Badge></span> : null}
    {all && !categories.length ? <Badge tone="slate">未分类</Badge> : null}
  </div>;
}
export function ModelCategoryFilter({ groups, selected, onChange }: { groups: { offers: CategorizedModel[] }[]; selected: string; onChange: (id: string) => void }) {
  const categories = publicModelCategories(groups.flatMap(g => g.offers));
  return <div role="group" aria-label="分类筛选" className="flex gap-1 overflow-x-auto pb-1 [&>button]:shrink-0">
    <Button size="sm" variant={!selected ? "primary" : "ghost"} aria-pressed={!selected} onClick={() => onChange("")}>全部分类 ({groups.length})</Button>
    {categories.map(c => <Button key={c.id} size="sm" variant={selected === c.id ? "primary" : "ghost"} aria-pressed={selected === c.id} onClick={() => onChange(c.id)}>{c.name} ({groups.filter(g => matchesModelCategory(g.offers, c.id)).length})</Button>)}
    <Button size="sm" variant={selected === "__uncategorized" ? "primary" : "ghost"} aria-pressed={selected === "__uncategorized"} onClick={() => onChange("__uncategorized")}>未分类 ({groups.filter(g => matchesModelCategory(g.offers, "__uncategorized")).length})</Button>
  </div>;
}
