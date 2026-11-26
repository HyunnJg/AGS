export interface Project {
  writable: boolean;
  id: string;
  name: string;
  root: string | null;
}
export interface Section {
  stateKey: string | null;
  statePath: string | null;
  stateVersion: string | null;
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
  version: string;
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

export type FileAction = "entries" | "file" | "search" | "attach" | "write" | "create";
export interface FileActivity {
  backup: string|null;
  id: number;
  time: number;
  action: FileAction;
  path: string | null;
  start: number | null;
  end: number | null;
  error: string | null;
}

export interface FileReference {
  id: string;
  project: string;
  path: string;
  start: number;
  end: number;
  text: string;
}
export const maxReferenceChars = 6000;
export const maxReferences = 8;

export interface WritePreview {
  id: string;
  path: string;
  action: "write" | "create";
  first: number;
  removed: string[];
  added: string[];
}
