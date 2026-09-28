# Editing and rerunning assessments

## Edit

Open an assessment that has not started and choose **Edit assessment**. Change its title,
course/programme, instructions, duration, pass mark, randomisation or questions. Questions and
options can be added/removed; answer keys and marks are validated using the authoring engine.
Candidate enrolments and registration links are preserved. Admission settings remain in Overview.

Edits are backed up in this tab's session storage, separately for each assessment. Signing out
clears those drafts. Saving checks the server's version; a stale draft cannot overwrite a newer
paper. Reload saved version requires confirmation. A successful save bypasses the unsaved-change
navigation warning. Started assessments cannot be edited, even after completion.

## Run again

On a completed assessment, choose **Run again**, name the new run and choose its participants:

- **Previous approved candidates** copies the old participant list.
- **Choose a roster** enrols its current approved members and attaches the roster to the new run.
  Pending requests are excluded. Archived, empty or other administrators' rosters cannot be used.
  Membership changes require refreshing and confirming the selection before preparation.
- **Invite candidates later** starts with an empty participant list.

The new assessment is independent and links to its source. Later roster changes do not
automatically change its participant list; additions can be reviewed before launch.

It gets new question/option IDs, a fresh registration link, fresh application-reference allocation,
and no sitting until explicitly started. Answers, attempts, marks, activity and results are not
copied or reset. Registration starts closed with no closing date; reopen it from Overview if new
candidates should join. With candidates omitted, use that registration workflow before launch.

Legacy access keys cannot be carried forward. Legacy assessments can be rerun as account-based
assessments using a roster or with no initial candidates. Repeated preparation requests with the same operation ID
return the same new assessment, including after the response was lost. A different explicit
preparation request creates another independent run.

The UI does not claim a physical-device or visual-browser validation. Automated tests cover
edit validation, stale writes, immutable prior results, retries, access boundaries and fresh runs.
