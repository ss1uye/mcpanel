import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { FileBrowser } from '../../components/FileBrowser';
import { FileEditorDialog } from '../../components/FileEditorDialog';

export function FilesTab() {
  const { instance } = useOutletContext<InstanceOutletContext>();
  const [path, setPath] = useState('/');
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <FileBrowser instanceId={instance.id} path={path} onPathChange={setPath} onEdit={setEditing} />
      <FileEditorDialog
        instanceId={instance.id}
        path={editing}
        onOpenChange={(open) => (!open ? setEditing(null) : undefined)}
      />
    </div>
  );
}
