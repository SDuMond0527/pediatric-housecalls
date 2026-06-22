import { Amplify } from 'aws-amplify'

let _configuredFor: 'providers' | 'families' | null = null

export function configureForProviders() {
  if (_configuredFor === 'providers') return
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_AWS_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_AWS_CLIENT_ID,
        signUpVerificationMethod: 'code',
      },
    },
  })
  _configuredFor = 'providers'
}

export function configureForFamilies() {
  if (_configuredFor === 'families') return
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_FAMILY_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_FAMILY_CLIENT_ID,
        signUpVerificationMethod: 'code',
      },
    },
  })
  _configuredFor = 'families'
}
