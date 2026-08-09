<!-- push-policy: ask -->
Always ask before pushing.

This governs pushes the agent makes on its own initiative, after a commit.
An explicit push the owner asks for — `git push`, or the `git` playbook's
push operation — is already authorized by the request and executes without
a confirmation prompt.
