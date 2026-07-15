import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GhostList } from "./GhostList";
import type { GhostView } from "../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// GhostCard はサムネイル解決等の依存を持つため、表示有無の検証用に最小モック化する
vi.mock("./GhostCard", () => ({
  GhostCard: ({ ghost, selected }: { ghost: GhostView; selected?: boolean }) => (
    <div data-testid="ghost-card" data-selected={selected ? "true" : undefined}>{ghost.name}</div>
  ),
}));

function makeGhost(name: string): GhostView {
  return {
    name,
    directory_name: name.toLowerCase(),
    path: `/${name}`,
    source: "ssp",
    name_lower: name.toLowerCase(),
    directory_name_lower: name.toLowerCase(),
  };
}

const baseProps = {
  sspPath: "C:/SSP",
  searchQuery: "",
  searchLoading: false,
  error: null as string | null,
  loadedStart: 0,
  onLoadMore: vi.fn(),
  selectedIndex: 0,
  selectionVisible: true,
  onClearSearch: vi.fn(),
};

describe("GhostList - スキャン中のキャッシュ表示（stale-while-revalidate）", () => {
  it("スキャン中（loading=true）でもキャッシュ済みゴーストがあれば一覧を表示する", () => {
    const ghosts = [makeGhost("Reimu"), makeGhost("Marisa")];
    render(<GhostList {...baseProps} ghosts={ghosts} total={2} loading={true} />);

    // スピナーではなく一覧（件数表示 + カード）を表示する
    expect(screen.queryByText("list.loading")).not.toBeInTheDocument();
    expect(screen.getByText("list.count")).toBeInTheDocument();
    expect(screen.getAllByTestId("ghost-card")).toHaveLength(2);
  });

  it("スキャン中でキャッシュが空（total=0）のときはスピナーを表示する", () => {
    render(<GhostList {...baseProps} ghosts={[]} total={0} loading={true} />);

    expect(screen.getByText("list.loading")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();
  });

  it("スキャン完了後（loading=false）にゴーストが無ければ空状態を表示する", () => {
    render(<GhostList {...baseProps} ghosts={[]} total={0} loading={false} />);

    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(screen.getByText("list.empty")).toBeInTheDocument();
  });

  it("selectedIndex のカードにハイライト（data-selected）が付く", () => {
    const ghosts = [makeGhost("Reimu"), makeGhost("Marisa")];
    render(<GhostList {...baseProps} ghosts={ghosts} total={2} loading={false} selectedIndex={1} />);

    const cards = screen.getAllByTestId("ghost-card");
    expect(cards[0]).not.toHaveAttribute("data-selected");
    expect(cards[1]).toHaveAttribute("data-selected", "true");
  });
});

describe("GhostList - 空状態の描き分け", () => {
  it("検索クエリがあり0件のときは検索専用の空表示とクリアボタンを出す", () => {
    const onClearSearch = vi.fn();
    render(
      <GhostList {...baseProps} ghosts={[]} total={0} loading={false} searchQuery="foo" onClearSearch={onClearSearch} />,
    );

    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(screen.getByText("list.emptySearch")).toBeInTheDocument();
    expect(screen.queryByText("list.empty")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("list.clearSearch"));
    expect(onClearSearch).toHaveBeenCalledTimes(1);
  });

  it("検索クエリが無く0件のときは通常の空表示（クリアボタンなし）", () => {
    render(<GhostList {...baseProps} ghosts={[]} total={0} loading={false} searchQuery="" />);

    expect(screen.getByText("list.empty")).toBeInTheDocument();
    expect(screen.queryByText("list.emptySearch")).not.toBeInTheDocument();
    expect(screen.queryByText("list.clearSearch")).not.toBeInTheDocument();
  });
});
