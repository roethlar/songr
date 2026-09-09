import { mount } from 'svelte';
import '../../src/app.css';
import OnboardingFlow from '../../src/lib/components/OnboardingFlow.svelte';
import { setCoreDiscovery } from '../../src/lib/stores/coreDiscoveryStore';
import { setCoreStatus } from '../../src/lib/stores/coreStore';
import { setSocketStatus } from '../../src/lib/stores/socketStatusStore';

setSocketStatus('connected');
mount(OnboardingFlow, { target: document.querySelector('#onboarding') as HTMLElement });
document.querySelector('#browse-library')!.addEventListener('click', () => {
	document.querySelector('#library-result')!.textContent = 'Library opened';
});

const fixture = { setCoreDiscovery, setCoreStatus, setSocketStatus };
declare global { interface Window { onboardingFixture: typeof fixture; } }
window.onboardingFixture = fixture;
