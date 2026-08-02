export default function RejectedPage() {

    return (

        <div className="flex min-h-dvh items-center justify-center bg-black px-3 py-5 text-white sm:px-6">

            <div className="w-full max-w-lg rounded-2xl border border-red-800 bg-red-950 p-5 text-center sm:p-10">

                <h1 className="mb-4 text-3xl font-bold text-red-400 sm:text-4xl">
                    Application Rejected
                </h1>

                <p className="text-base leading-7 text-neutral-300 sm:text-lg sm:leading-8">
                    Your access request was rejected by the admin.
                </p>

            </div>

        </div>

    )

}
