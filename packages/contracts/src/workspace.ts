export interface Project {
  id: string;
  name: string;
  root: string | null;
}
export interface Section {
  id: string;
  projectId: string;
  name: string;
}
export interface WorkspaceCatalog {
  projects: Project[];
  sections: Section[];
}
export interface DirectoryPage {
  entries: { name: string; kind: "folder" | "file" }[];
  next: number | null;
}
export interface FilePage {
  start: number;
  end: number;
  total: number;
  text: string;
  clipped: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  excerpt: string;
  version: string;
}
export interface WorkspaceSearch {
  hits: SearchHit[];
  files: number;
  skipped: number;
  limited: boolean;
}

export type FileAction = "entries" | "file" | "search";
export interface FileActivity {
  id: number;
  time: number;
  action: FileAction;
  path: string | null;
  start: number | null;
  end: number | null;
  error: string | null;
}
