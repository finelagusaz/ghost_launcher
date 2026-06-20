import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GhostList } from "./GhostList";
import type { GhostView } from "../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// GhostCard はサムネイル解決等の依存を持つため、表示有無の検証用に最小モック化する
vi.mock("./GhostCard", () => ({
  GhostCard: ({ ghost }: { ghost: GhostView }) => (
    <div data-testid="ghost-card">{ghost.name}</div>
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
});
