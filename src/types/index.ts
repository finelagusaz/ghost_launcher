export interface Ghost {
  name: string;
  directory_name: string;
  path: string;
  source: string;
}

export interface GhostView extends Ghost {
  name_lower: string;
  directory_name_lower: string;
}
