import { Field, Input, makeStyles } from "@fluentui/react-components";
import { SearchRegular } from "@fluentui/react-icons";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

const useStyles = makeStyles({
  root: {
    maxWidth: "480px",
    width: "100%",
    minWidth: 0,
  },
});

export function SearchBox({ value, onChange }: Props) {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <Field label="ゴースト検索">
        <Input
          contentBefore={<SearchRegular />}
          placeholder="ゴースト名で検索"
          value={value}
          onChange={(_: unknown, data: { value: string }) => onChange(data.value)}
        />
      </Field>
    </div>
  );
}
