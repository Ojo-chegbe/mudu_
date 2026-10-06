import { useEffect, useId, useRef, useState } from 'react';
import type { BankProject, BankQuestion } from '../../packages/contracts/question-bank.ts';
import { BankGenerate } from './bank-generate.tsx';
import { ProjectDialog, ProjectDirectory } from './bank-projects.tsx';
import { Icon } from './ui.tsx';

export function AssessmentGenerate({
  remaining,
  onAdd,
  onClose,
}: {
  remaining: number;
  onAdd: (questions: BankQuestion[]) => void;
  onClose: () => void;
}) {
  const [project, setProject] = useState<BankProject | null>(null);
  const [creating, setCreating] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const titleId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!creating) dialog.current?.showModal();
  }, [creating]);
  if (creating)
    return (
      <ProjectDialog
        onClose={() => setCreating(false)}
        onSaved={(value) => {
          setProject(value);
          setCreating(false);
        }}
      />
    );
  return (
    <dialog
      ref={dialog}
      className="dialog assessment-generation-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="assessment-generation-heading">
        <div>
          <h2 id={titleId}>Generate with AI</h2>
          <p className="field-hint">
            {project
              ? `Questions are saved in ${project.name}. Review and approve them before adding to your paper.`
              : 'Choose a project for your questions, or create a new one.'}
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close generation and return to assessment"
          onClick={onClose}
        >
          <Icon name="close" size={19} />
        </button>
      </div>
      {project ? (
        <BankGenerate
          key={project.id}
          projectId={project.id}
          embedded
          remaining={remaining}
          onAdd={(questions) => {
            if (!alive.current) return;
            onAdd(questions);
            onClose();
          }}
        />
      ) : (
        <ProjectDirectory
          picker
          activeOnly
          onOpen={setProject}
          onCreate={() => setCreating(true)}
        />
      )}
    </dialog>
  );
}
