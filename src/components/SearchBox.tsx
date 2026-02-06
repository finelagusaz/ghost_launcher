import { Input } from "@fluentui/react-components";
import { SearchRegular } from "@fluentui/react-icons";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export function SearchBox({ value, onChange }: Props) {
  return (
    <Input
      contentBefore={<SearchRegular />}
      placeholder="ゴースト名で検索..."
      value={value}
      onChange={(_: unknown, data: { value: string }) => onChange(data.value)}
    />
  );
}
