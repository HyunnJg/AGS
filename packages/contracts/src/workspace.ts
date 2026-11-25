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
